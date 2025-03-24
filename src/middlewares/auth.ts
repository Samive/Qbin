import {Context} from "https://deno.land/x/oak/mod.ts";
import {OAuth2Client} from "jsr:@cmd-johnson/oauth2-client@^2.0.0";
import {generateJwtToken, verifyJwtToken} from "../utils/crypto.ts";
import {kv} from "../utils/cache.ts";
import {PasteError} from "../utils/response.ts";
import {ADMIN, exactPaths, HEADERS, prefixPaths, TOKEN_EXPIRE, get_env, LEVEL, EMAIL} from "../config/constants.ts";
import {getLoginPageHtml} from "../utils/render.ts";

// 定义 OAuth2 提供商配置
// https://github.com/cmd-johnson/deno-oauth2-client
const oauthProviders = {
  // Google OAuth2 配置
  google: {
    client: new OAuth2Client({
      clientId: get_env("GOOGLE_CLIENT_ID") || "",
      clientSecret: get_env("GOOGLE_CLIENT_SECRET") || "",
      authorizationEndpointUri: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUri: "https://oauth2.googleapis.com/token",
      redirectUri: get_env("GOOGLE_CALLBACK_URL") || "http://localhost:8000/api/login/oauth2/callback/google",
      defaults: {
        scope: ["profile", "email"],
      },
    }),
    userInfoUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
    userDataTransformer: (userData: any): UserData => ({
      id: userData.sub,
      name: userData.name || userData.email?.split('@')[0] || "User",
      email: userData.email,
      level: LEVEL, // Google 用户的默认等级
      provider: "google",
    }),
    validateUser: (userData: any): boolean => userData.email_verified === true,
  },
  // GitHub OAuth2 配置
  github: {
    client: new OAuth2Client({
      clientId: get_env("GITHUB_CLIENT_ID") || "",
      clientSecret: get_env("GITHUB_CLIENT_SECRET") || "",
      authorizationEndpointUri: "https://github.com/login/oauth/authorize",
      tokenUri: "https://github.com/login/oauth/access_token",
      redirectUri: get_env("GITHUB_CALLBACK_URL") || "http://localhost:8000/api/login/oauth2/callback/github",
      defaults: {
        scope: ["read:user", "user:email"],
      },
    }),
    userInfoUrl: "https://api.github.com/user",
    userDataTransformer: (userData: any): UserData => ({
      id: userData.id.toString(),
      name: userData.login,
      email: userData.email,
      level: LEVEL, // GitHub 用户的默认等级
      provider: "github",
    }),
    validateUser: (userData: any): boolean => userData.id !== undefined,
    // GitHub 可能需要额外的请求来获取邮箱信息
    getAdditionalData: async (accessToken: string): Promise<any> => {
      if (!accessToken) return {};

      try {
        const emailsResponse = await fetch("https://api.github.com/user/emails", {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json"
          },
        });

        if (emailsResponse.ok) {
          const emails = await emailsResponse.json();
          const primaryEmail = emails.find((email: any) => email.primary && email.verified);

          if (primaryEmail) {
            return { email: primaryEmail.email };
          }
        }

        return {};
      } catch (error) {
        console.error("Error fetching GitHub emails:", error);
        return {};
      }
    }
  },
  // Linux.do OAuth2 配置
  linuxdo: {
    client: new OAuth2Client({
      clientId: get_env("LINUXDO_CLIENT_ID") || "",
      clientSecret: get_env("LINUXDO_CLIENT_SECRET") || "",
      authorizationEndpointUri: "https://connect.linux.do/oauth2/authorize",
      tokenUri: "https://connect.linux.do/oauth2/token",
      redirectUri: get_env("LINUXDO_CALLBACK_URL") || "http://localhost:8000/api/login/oauth2/callback/linuxdo",
      defaults: {
        scope: ["user:profile"],
      },
    }),
    userInfoUrl: "https://connect.linux.do/api/user",
    userDataTransformer: (userData: any): UserData => ({
      id: userData.id,
      name: userData.username,
      email: userData.email,
      level: userData.trust_level,
      provider: "linuxdo",
    }),
    validateUser: (userData: any): boolean => userData.active === true,
  },
};

/**
 * 认证中间件
 * - 从 Cookie 中读取 token 并验证
 * - 无 token 时尝试做 OAuth2 登录流程
 * - 若未登录且访问受限路由，则显示登录页面
 */
export async function authMiddleware(ctx: Context, next: () => Promise<unknown>) {
  const session = ctx.state.session;
  const token = await ctx.cookies.get("token");  // 从 cookie 中取出 Token
  if (token) {
    try {
      // 若 Session 中没有用户信息，但 JWT 有，则写回 Session
      const userFromJwt = await verifyJwtToken(token);
      if(userFromJwt){
         session.set("user", {
          id: userFromJwt.id,
          name: userFromJwt.name,
          email: userFromJwt.email,
          level: userFromJwt.level,
        });
      }
    }
    catch (e) {
      console.warn("JWT verify error:", e);
      // token 无效或过期，可根据需求决定是否清除 Cookie
      await ctx.cookies.set('token', '', {
        maxAge: 0,
        httpOnly: true,
        sameSite: "lax",
        path: '/'
      });
      ctx.response.status = 401;
      ctx.response.body = { msg: "Cookie Expired" };
      return;
    }
  }

  if (session?.has("user")) {
    if(session.get("user")?.level >= LEVEL){
      Object.entries(HEADERS.HTML).forEach(([k, v]) => {
        ctx.response.headers.set(k, v);
      });
      await next();
    }else {
      await ctx.cookies.set('token', '', {
        maxAge: 0,
        httpOnly: true,
        sameSite: "lax",
        path: '/'
      });
      ctx.response.status = 401;
      ctx.response.body = { msg: "auth error" };
    }
    return;
  }

  const currentPath = ctx.request.url.pathname;
  const method = ctx.request.method;
  const isExactPathAuth = method === "GET" && exactPaths.includes(currentPath);
  const isPrefixPathAuth = method === "GET" && prefixPaths.some(prefix => currentPath.startsWith(prefix));
  // 允许匿名访问的接口
  if (isPrefixPathAuth || isExactPathAuth){
    // 公开路径，无需认证
    await next();
    return;
  }

  // 否则未登录 => 返回登录页面
  await getLoginPageHtml(ctx, 200);
}

export const handleAdminLogin = async (ctx: Context) => {
  const apikey = ctx.request.headers.get("x-apikey");
  if (apikey && !(ADMIN[apikey] >= LEVEL)){
    ctx.response.status = 403;
    ctx.response.body = { msg: "apikey error" };
    return;
  }
  const jwtToken = await generateJwtToken({
    id: 0,
    email: EMAIL,
    name: EMAIL,
    level: ADMIN[apikey],
  });
  await ctx.cookies.set("token", jwtToken, {
    maxAge: TOKEN_EXPIRE * 1000,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  ctx.response.status = 200;
  ctx.response.body = { msg: "ok" };
  // ctx.response.body = { token: jwtToken, expire: TOKEN_EXPIRE * 1000};
}

// 处理 OAuth2 登录重定向
export const handleLogin = async (ctx: Context) => {
  try {
    const provider = ctx.params.provider;
    if (!oauthProviders[provider]) {
      ctx.response.status = 400;
      ctx.response.body = { error: "无效的 OAuth 提供商" };
      return;
    }

    const oauth2Client = oauthProviders[provider].client;
    console.log(oauth2Client)
    const { uri, codeVerifier } = await oauth2Client.code.getAuthorizationUri();
    const sessionId = crypto.randomUUID();

    await kv.set(["oauth_sessions", sessionId], { provider, codeVerifier }, { expireIn: 60000 });
    ctx.cookies.set("session_id", sessionId, {
      maxAge: 60000,  // 60秒过期
      httpOnly: true,
      sameSite: "lax"
    });
    ctx.response.redirect(uri);
  } catch (error) {
    console.error("OAuth 登录错误:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "认证错误" };
  }
}

// 处理 OAuth2 回调请求
export const handleOAuthCallback = async (ctx: Context) => {
  try {
    const providerParam = ctx.params.provider;
    if (!oauthProviders[providerParam]) throw new PasteError(400, "无效的 OAuth 提供商");
    const sessionId = await ctx.cookies.get("session_id");
    if (!sessionId) throw new PasteError(400, "未找到会话");
    const sessionDataResult = await kv.get(["oauth_sessions", sessionId]);
    if (!sessionDataResult) throw new PasteError(400, "无效的会话");

    const { provider, codeVerifier } = sessionDataResult.value;
    if (provider !== providerParam) throw new PasteError(400, "提供商不匹配");
    await kv.delete(["oauth_sessions", sessionId]);

    const oauth2Client = oauthProviders[provider].client;
    const tokens = await oauth2Client.code.getToken(ctx.request.url, {
      codeVerifier: codeVerifier
    });

    const userResponse = await fetch(oauthProviders[provider].userInfoUrl, {
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        Accept: "application/json"
      },
    });
    if (!userResponse.ok) throw new PasteError(500, `获取用户数据失败: ${userResponse.statusText}`);
    const userData = await userResponse.json();

    let additionalData = {};
    if (provider === "github" && oauthProviders.github.getAdditionalData) {
      additionalData = await oauthProviders.github.getAdditionalData(tokens.accessToken);
    }
    const mergedUserData = { ...userData, ...additionalData };
    if (!oauthProviders[provider].validateUser(mergedUserData)) {
      throw new PasteError(403, "OAuth2 用户验证失败");
    }
    const transformedUserData = oauthProviders[provider].userDataTransformer(mergedUserData);
    const jwtToken = await generateJwtToken({
      id: transformedUserData.id,
      name: transformedUserData.name,
      email: transformedUserData.email,
      level: transformedUserData.level,
      provider: transformedUserData.provider,
    });
    await ctx.cookies.set("token", jwtToken, {
      maxAge: TOKEN_EXPIRE * 1000,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
    ctx.response.redirect("/");
  } catch (error) {
    console.error("OAuth 回调错误:", error);

    if (error instanceof PasteError) {
      ctx.response.status = error.status;
      ctx.response.body = { error: error.message };
    } else {
      ctx.response.status = 500;
      ctx.response.body = { error: "认证回调错误" };
    }
  }
};