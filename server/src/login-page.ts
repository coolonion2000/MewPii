/** dsh-styled login page served at /login. Plain HTML, no build step. */
export function loginPageHtml(error = false, next = '/'): string {
  const safeNextJson = JSON.stringify(next).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MewPii - 登录</title>
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    background: #151517;
    color: #f9fafb;
    display: grid;
    place-items: center;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 340px; max-width: 92vw;
    background: #1b1b1c;
    border: 1px solid #ffffff0f;
    border-radius: 16px;
    padding: 36px 30px 30px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.4);
  }
  .logo {
    width: 210px; height: auto;
    margin: 0 auto 22px;
    display: block;
  }
  h1 { font-size: 18px; font-weight: 600; text-align: center; margin: 0 0 4px; }
  .sub { text-align: center; font-size: 13px; color: #81858c; margin-bottom: 22px; }
  input[type="password"] {
    width: 100%; border: 1px solid #ffffff1f; border-radius: 10px;
    background: #151517; color: #f9fafb;
    padding: 10px 14px; font-size: 14px; font-family: inherit; outline: none;
    transition: border-color 0.15s;
  }
  input[type="password"]:focus { border-color: #4176e6; }
  button {
    width: 100%; margin-top: 14px;
    border: none; border-radius: 10px; cursor: pointer;
    background: #4176e6; color: #fff;
    font-size: 14px; font-weight: 500; font-family: inherit;
    padding: 10px 0;
    transition: filter 0.15s;
  }
  button:hover { filter: brightness(1.1); }
  button:disabled { opacity: 0.5; cursor: default; }
  .error {
    display: ${error ? 'block' : 'none'};
    background: #f25a5a26; color: #f25a5a;
    border-radius: 8px; padding: 8px 12px; font-size: 13px;
    margin-bottom: 14px; text-align: center;
  }
  .hint { margin-top: 16px; text-align: center; font-size: 12px; color: #61666b; }
</style>
</head>
<body>
  <form class="card" id="form">
    <img class="logo" src="/logo-wide-dark.png" alt="MewPii" />
    <div class="error" id="error">密码错误，请重试</div>
    <input type="password" id="password" placeholder="访问密码" autofocus autocomplete="current-password" />
    <button type="submit" id="btn">登 录</button>
  </form>
<script>
  const form = document.getElementById('form');
  const btn = document.getElementById('btn');
  const next = ${safeNextJson};
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: document.getElementById('password').value }),
      });
      if (res.ok) {
        location.replace(next);
      } else {
        location.replace('/login?error=1&next=' + encodeURIComponent(next));
      }
    } catch {
      btn.disabled = false;
    }
  });
</script>
</body>
</html>`;
}
