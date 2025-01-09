// 配置常量
const CONFIG = {
  RETRY_ATTEMPTS: 3,      // 重试次数
  RETRY_DELAY: 1000,      // 重试延迟（毫秒）
  MIN_RANDOM_DELAY: 1000, // 最小随机延迟（毫秒）
  MAX_RANDOM_DELAY: 9000, // 最大随机延迟（毫秒）
  RATE_LIMIT: { MAX_REQUESTS: 100, WINDOW: 3600000 }, // 限流：每小时最多100请求
  COOKIE_MAX_AGE: 86400   // Cookie 过期时间（24小时，单位：秒）
};

// 延迟函数
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 创建成功结果对象
function createSuccessResult(username, type, message) {
  return {
    username,
    type,
    cronResults: [{ success: true, message }],
    lastRun: new Date().toISOString()
  };
}

// 创建错误结果对象
function createErrorResult(username, type, message, retryCount = 0) {
  return {
    username,
    type,
    cronResults: [{ success: false, message, retryCount }],
    lastRun: new Date().toISOString()
  };
}

// 错误日志记录
async function logError(error, context, env) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${context}: ${error.message}`;
  console.error(logMessage);
  await sendTelegramMessage(`错误警告: ${logMessage}`, env);
}

// 生成随机 User-Agent
function generateRandomUserAgent() {
  const browsers = ['Chrome', 'Firefox', 'Safari', 'Edge', 'Opera'];
  const browser = browsers[Math.floor(Math.random() * browsers.length)];
  const version = Math.floor(Math.random() * 100) + 1;
  const os = ['Windows NT 10.0', 'Macintosh', 'X11'];
  const selectedOS = os[Math.floor(Math.random() * os.length)];
  const osVersion = selectedOS === 'X11' ? 'Linux x86_64' : 
                   selectedOS === 'Macintosh' ? 'Intel Mac OS X 10_15_7' : 
                   'Win64; x64';

  return `Mozilla/5.0 (${selectedOS}; ${osVersion}) AppleWebKit/537.36 (KHTML, like Gecko) ${browser}/${version}.0.0.0 Safari/537.36`;
}

// 请求频率限制
const rateLimit = {
  requests: new Map(),
  checkLimit: function(ip) {
    const now = Date.now();
    const userRequests = this.requests.get(ip) || [];
    const recentRequests = userRequests.filter(time => now - time < CONFIG.RATE_LIMIT.WINDOW);
    this.requests.set(ip, [...recentRequests, now]);
    return recentRequests.length >= CONFIG.RATE_LIMIT.MAX_REQUESTS;
  }
};

// User-Agent 缓存
const userAgentCache = {
  cache: new Map(),
  get: function() {
    const now = Math.floor(Date.now() / 3600000);
    if (!this.cache.has(now)) {
      this.cache.clear();
      this.cache.set(now, generateRandomUserAgent());
    }
    return this.cache.get(now);
  }
};

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  },
  async scheduled(event, env, ctx) {
    return handleScheduled(event.scheduledTime, env);
  }
};

// 处理 HTTP 请求的主函数
async function handleRequest(request, env) {
  try {
    const url = new URL(request.url);
    const clientIP = request.headers.get('CF-Connecting-IP');

    if (rateLimit.checkLimit(clientIP)) {
      return new Response('Too Many Requests', { status: 429 });
    }

    switch(url.pathname) {
      case '/login':
        return handleLogin(request, env);
      case '/run':
        return handleRun(request, env);
      case '/results':
        return handleResults(request, env);
      case '/check-auth':
        return handleCheckAuth(request, env);
      default:
        return new Response(getHtmlContent(), {
          headers: { 'Content-Type': 'text/html' },
        });
    }
  } catch (error) {
    await logError(error, 'Request Handler', env);
    return new Response('Internal Server Error', { status: 500 });
  }
}

// 添加这个函数
async function handleCheckAuth(request, env) {
  return new Response(JSON.stringify({
    authenticated: isAuthenticated(request, env)
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// 处理登录请求
async function handleLogin(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const formData = await request.formData();
    const password = formData.get('password');
    
    if (password === env.PASSWORD) {
      const response = new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
      response.headers.set('Set-Cookie', 
        `auth=${env.PASSWORD}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${CONFIG.COOKIE_MAX_AGE}`
      );
      return response;
    }
    
    return new Response(JSON.stringify({ success: false }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    await logError(error, 'Login Handler', env);
    return new Response('Internal Server Error', { status: 500 });
  }
}

// 处理运行脚本请求
async function handleRun(request, env) {
  if (!isAuthenticated(request, env)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  // 创建异步执行函数
  const executeScript = async () => {
    try {
      const response = await fetch(env.ACCOUNTS_URL);
      const accountsData = await response.json();
      const accounts = accountsData.accounts;
      
      let results = [];
      let successCount = 0;
      let failureCount = 0;

      for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];
        // 发送开始处理某个账号的消息
        await writer.write(encoder.encode(JSON.stringify({
          type: 'processing',
          message: `正在登录 ${account.username} (${account.type})...`,
          current: i + 1,
          total: accounts.length
        }) + '\n'));

        const result = await loginWithRetry(account, env);
        results.push(result);

        // 更新统计
        if (result.cronResults[0].success) {
          successCount++;
        } else {
          failureCount++;
        }

        // 发送进度更新
        await writer.write(encoder.encode(JSON.stringify({
          type: 'progress',
          completed: i + 1,
          total: accounts.length,
          result: result,
          stats: {
            success: successCount,
            failure: failureCount,
            total: accounts.length
          }
        }) + '\n'));

        await delay(
          Math.floor(Math.random() * 
          (CONFIG.MAX_RANDOM_DELAY - CONFIG.MIN_RANDOM_DELAY)) + 
          CONFIG.MIN_RANDOM_DELAY
        );
      }

      // 发送完成消息
      const summary = `总共${accounts.length}个账号，成功${successCount}个，失败${failureCount}个`;
      await writer.write(encoder.encode(JSON.stringify({
        type: 'complete',
        message: summary,
        stats: {
          success: successCount,
          failure: failureCount,
          total: accounts.length
        }
      }) + '\n'));

      await env.SERV_LOGIN.put('lastResults', JSON.stringify(results));
      // 发送 TG 汇总消息
      await sendTelegramMessage(null, env, results);  // 传入 results 参数来生成完整报告
    } catch (error) {
      await writer.write(encoder.encode(JSON.stringify({
        type: 'error',
        message: error.message
      }) + '\n'));
    } finally {
      await writer.close();
    }
  };

  // 启动异步执行
  executeScript();

  return new Response(stream.readable, {
    headers: { 
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  });
}

// 处理结果请求
async function handleResults(request, env) {
  if (!isAuthenticated(request, env)) {
    return new Response(JSON.stringify({ authenticated: false }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const results = await env.SERV_LOGIN.get('lastResults', 'json');
    return new Response(JSON.stringify({ 
      authenticated: true, 
      results: results || [] 
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    await logError(error, 'Results Handler', env);
    return new Response('Internal Server Error', { status: 500 });
  }
}

// 定时任务处理函数
async function handleScheduled(scheduledTime, env) {
  try {
    const response = await fetch(env.ACCOUNTS_URL);
    const accountsData = await response.json();
    const accounts = accountsData.accounts;
    
    let results = [];
    for (const account of accounts) {
      const result = await loginWithRetry(account, env);  // 添加 env 参数
      results.push(result);
      await delay(
        Math.floor(Math.random() * 
        (CONFIG.MAX_RANDOM_DELAY - CONFIG.MIN_RANDOM_DELAY)) + 
        CONFIG.MIN_RANDOM_DELAY
      );
    }

    await env.SERV_LOGIN.put('lastResults', JSON.stringify(results));
    await sendTelegramMessage(`定时任务完成`, env, results);
  } catch (error) {
    await logError(error, 'Scheduled Handler', env);
  }
}

// 处理认证检查请求
function isAuthenticated(request, env) {
  const cookies = request.headers.get('Cookie');
  if (cookies) {
    const authCookie = cookies.split(';').find(c => c.trim().startsWith('auth='));
    if (authCookie) {
      const authValue = authCookie.split('=')[1];
      return authValue === env.PASSWORD;
    }
  }
  return false;
}

// 提取 CSRF Token
function extractCsrfToken(pageContent) {
  const csrfMatch = pageContent.match(/name="csrfmiddlewaretoken" value="([^"]*)"/)
  if (!csrfMatch) {
    throw new Error('CSRF token not found');
  }
  return csrfMatch[1];
}

// 处理登录响应
function handleLoginResponse(response, username, type, env) {
  if (response.status === 302) {
    const message = '登录成功';
    // 单个账号不需要发送 TG 通知，避免消息过多
    return createSuccessResult(username, type, message);
  } else {
    const message = '登录失败，未知原因。请检查账号和密码是否正确。';
    console.error(message);
    return createErrorResult(username, type, message);
  }
}

// 账号登录检查函数
async function loginAccount(account, env) {
  const { username, password, panelnum, type } = account;
  const baseUrl = type === 'ct8' 
    ? 'https://panel.ct8.pl' 
    : `https://panel${panelnum}.serv00.com`;
  const loginUrl = `${baseUrl}/login/`;
  const userAgent = userAgentCache.get();

  try {
    const response = await fetch(loginUrl, {
      method: 'GET',
      headers: {
        'User-Agent': userAgent,
      },
    });

    const pageContent = await response.text();
    const csrfToken = extractCsrfToken(pageContent);
    const initialCookies = response.headers.get('set-cookie') || '';

    const loginResponse = await fetch(loginUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': loginUrl,
        'User-Agent': userAgent,
        'Cookie': initialCookies,
      },
      body: new URLSearchParams({
        'username': username,
        'password': password,
        'csrfmiddlewaretoken': csrfToken,
        'next': '/'
      }).toString(),
      redirect: 'manual'
    });

    return handleLoginResponse(loginResponse, username, type, env);
  } catch (error) {
    await logError(error, `Login Account: ${username}`, env);
    return createErrorResult(username, type, error.message);
  }
}

// 带重试机制的登录函数
async function loginWithRetry(account, env, attempts = CONFIG.RETRY_ATTEMPTS) {
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await loginAccount(account, env);
      if (result.cronResults[0].success) {
        return result;
      }
      await delay(CONFIG.RETRY_DELAY * (i + 1));
    } catch (error) {
      if (i === attempts - 1) {
        throw error;
      }
      await delay(CONFIG.RETRY_DELAY * (i + 1));
    }
  }
  return createErrorResult(
    account.username, 
    account.type, 
    `登录失败，已重试 ${attempts} 次`
  );
}

// 用于发送简单消息的辅助函数
async function sendSimpleTelegramMessage(message, env) {
  const url = `https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TG_ID,
        text: message
      })
    });
  } catch (error) {
    console.error('Error sending Telegram message:', error);
  }
}

// 发送 Telegram 通知
async function sendTelegramMessage(message, env, results = null) {
  if (!results) {
    return await sendSimpleTelegramMessage(message, env);
  }

  const now = new Date().toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).replace(/\//g, '-');

  const successCount = results.filter(r => r.cronResults[0].success).length;
  const failureCount = results.length - successCount;

  let messageText = `🤖 Serv00 登录状态报告\n`;
  messageText += `⏰ 时间: ${now}\n`;
  messageText += `📊 总计: ${results.length} 个账户\n`;
  messageText += `✅ 成功: ${successCount} | ❌ 失败: ${failureCount}\n\n`;

  // 修改每个账户的状态显示格式
  for (const result of results) {
    const success = result.cronResults[0].success;
    messageText += `${result.username}\n`;
    messageText += `状态: ${success ? '✅ 登录成功' : '❌ 登录失败'}`;
    
    if (!success && result.cronResults[0].message) {
      messageText += `\n失败原因：${result.cronResults[0].message}`;
    }
    messageText += '\n\n';
  }

  const url = `https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TG_ID,
        text: messageText
      })
    });
  } catch (error) {
    console.error('Error sending Telegram message:', error);
  }
}

// 最后一个函数：HTML 内容生成
function getHtmlContent() {
  return `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Serv00 账户批量登录</title>
    <style>
      body {
        font-family: Arial, sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        min-height: 100vh;
        margin: 0;
        background-color: #f0f0f0;
      }
      .container {
        text-align: center;
        padding: 20px;
        background-color: white;
        border-radius: 8px;
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        max-width: 800px;
        width: 100%;
      }
      input, button {
        margin: 10px 0;
        padding: 10px;
        width: 200px;
        border-radius: 4px;
        border: 1px solid #ddd;
      }
      button {
        background-color: #4CAF50;
        border: none;
        color: white;
        cursor: pointer;
      }
      button:hover {
        background-color: #45a049;
      }
      button:disabled {
        background-color: #cccccc;
        cursor: not-allowed;
      }
      #status {
        margin-top: 20px;
        font-weight: bold;
      }
      #summary {
        margin: 10px 0;
        font-weight: bold;
        color: #333;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 20px;
      }
      th, td {
        border: 1px solid #ddd;
        padding: 8px;
        text-align: left;
      }
      th {
        background-color: #f2f2f2;
      }
      #loginForm {
        display: block;
      }
      #dashboard {
        display: none;
      }
      .error {
        color: #ff0000;
      }
      .success {
        color: #4CAF50;
      }
      .processing {
        color: #2196F3;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Serv00登录控制面板</h1>
      <div id="loginForm">
        <input type="password" id="password" placeholder="请输入密码">
        <button id="loginButton">登录</button>
      </div>
      <div id="dashboard">
        <button id="runButton">执行脚本</button>
        <div id="status"></div>
        <div id="summary"></div>
        <table id="resultsTable">
          <thead>
            <tr>
              <th>账号</th>
              <th>类型</th>
              <th>状态</th>
              <th>消息</th>
              <th>执行时间</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
    <script>
      async function checkAuth() {
        try {
          const response = await fetch('/check-auth');
          const data = await response.json();
          if (data.authenticated) {
            showDashboard();
          } else {
            showLoginForm();
          }
        } catch (error) {
          console.error('Auth check failed:', error);
          showLoginForm();
        }
      }

      function init() {
        const loginButton = document.getElementById('loginButton');
        const passwordInput = document.getElementById('password');
        const runButton = document.getElementById('runButton');
        
        if (loginButton) {
          loginButton.addEventListener('click', login);
        }
        
        if (passwordInput) {
          passwordInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
              e.preventDefault();
              login();
            }
          });
        }
        
        if (runButton) {
          runButton.addEventListener('click', runScript);
        }
        
        checkAuth();
      }

      function showLoginForm() {
        const loginForm = document.getElementById('loginForm');
        const dashboard = document.getElementById('dashboard');
        if (loginForm) loginForm.style.display = 'block';
        if (dashboard) dashboard.style.display = 'none';
      }

      function showDashboard() {
        const loginForm = document.getElementById('loginForm');
        const dashboard = document.getElementById('dashboard');
        if (loginForm) loginForm.style.display = 'none';
        if (dashboard) dashboard.style.display = 'block';
        fetchResults();
      }

      async function login() {
        const passwordInput = document.getElementById('password');
        if (!passwordInput) return;
        
        const formData = new FormData();
        formData.append('password', passwordInput.value);
        
        try {
          const response = await fetch('/login', { 
            method: 'POST',
            body: formData,
            headers: {
              'Accept': 'application/json'
            }
          });
          
          if (!response.ok) {
            throw new Error('登录请求失败');
          }
          
          const result = await response.json();
          
          if (result.success) {
            await checkAuth();
          } else {
            alert('密码错误');
            passwordInput.value = '';
            passwordInput.focus();
          }
        } catch (error) {
          console.error('Login failed:', error);
          alert('登录失败，请重试');
          passwordInput.value = '';
          passwordInput.focus();
        }
      }

      async function runScript() {
        const statusDiv = document.getElementById('status');
        const summaryDiv = document.getElementById('summary');
        const runButton = document.getElementById('runButton');
        const tbody = document.querySelector('#resultsTable tbody');
        
        statusDiv.textContent = '正在执行脚本...';
        statusDiv.className = 'processing';
        runButton.disabled = true;
        summaryDiv.textContent = '';
        tbody.innerHTML = '';
        
        try {
          const response = await fetch('/run', { 
            method: 'POST',
            headers: {
              'Accept': 'application/json'
            }
          });

          if (!response.ok) {
            if (response.status === 401) {
              statusDiv.textContent = '未授权，请重新登录。';
              statusDiv.className = 'error';
              showLoginForm();
              return;
            }
            throw new Error('请求失败');
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const text = decoder.decode(value);
            const lines = text.split('\\n').filter(line => line.trim());

            for (const line of lines) {
              try {
                const data = JSON.parse(line);
                handleStreamData(data);
              } catch (e) {
                console.error('解析数据失败:', e);
              }
            }
          }
        } catch (error) {
          statusDiv.textContent = '执行出错: ' + error.message;
          statusDiv.className = 'error';
        } finally {
          runButton.disabled = false;
        }
      }

      function handleStreamData(data) {
        const statusDiv = document.getElementById('status');
        const summaryDiv = document.getElementById('summary');

        switch (data.type) {
          case 'processing':
            statusDiv.textContent = data.message;
            statusDiv.className = 'processing';
            break;
          case 'progress':
            addOrUpdateResultRow(data.result);
            if (data.stats) {
              summaryDiv.textContent = 
                \`总共\${data.stats.total}个账号，\` +
                \`成功\${data.stats.success}个，\` +
                \`失败\${data.stats.failure}个\`;
            }
            break;
          case 'complete':
            statusDiv.textContent = '执行完成！';
            statusDiv.className = 'success';
            summaryDiv.textContent = data.message;
            break;
          case 'error':
            statusDiv.textContent = '执行出错: ' + data.message;
            statusDiv.className = 'error';
            break;
        }
      }

      function addOrUpdateResultRow(result) {
        const tbody = document.querySelector('#resultsTable tbody');
        const existingRow = Array.from(tbody.rows).find(row => 
          row.cells[0].textContent === result.username && 
          row.cells[1].textContent === result.type
        );
        
        const success = result.cronResults[0].success;
        const statusText = success ? '✅ 成功' : '❌ 失败';
        const message = success ? '' : ' | 失败原因：' + result.cronResults[0].message;
        
        if (existingRow) {
          existingRow.cells[2].textContent = statusText;
          existingRow.cells[2].className = success ? 'success' : 'error';
          existingRow.cells[3].textContent = message;
          existingRow.cells[4].textContent = new Date(result.lastRun).toLocaleString('zh-CN');
        } else {
          const row = tbody.insertRow(0);
          row.insertCell(0).textContent = result.username;
          row.insertCell(1).textContent = result.type;
          const statusCell = row.insertCell(2);
          statusCell.textContent = statusText;
          statusCell.className = success ? 'success' : 'error';
          row.insertCell(3).textContent = message;
          row.insertCell(4).textContent = new Date(result.lastRun).toLocaleString('zh-CN');
        }
      }

      async function fetchResults() {
        try {
          const response = await fetch('/results');
          if (response.ok) {
            const data = await response.json();
            if (data.authenticated) {
              if (data.results) {
                data.results.forEach(result => addOrUpdateResultRow(result));
              }
            } else {
              showLoginForm();
            }
          } else {
            throw new Error('Failed to fetch results');
          }
        } catch (error) {
          console.error('Error fetching results:', error);
          showLoginForm();
        }
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
      } else {
        init();
      }
    </script>
  </body>
  </html>
  `;
}