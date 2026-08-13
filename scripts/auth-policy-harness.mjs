import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const phase = process.argv[2];
const authUrl = requiredEnvironment("NEVIX_AUTH_POLICY_URL");
const databaseContainer = process.env.NEVIX_AUTH_POLICY_DATABASE_CONTAINER;
const legacyEmail = process.env.NEVIX_AUTH_POLICY_LEGACY_EMAIL;
const pwnedPassword = "Password123!";

if (phase === "bootstrap") {
  await expectStatus(
    await signUp(requiredValue(legacyEmail, "legacy email"), pwnedPassword),
    200,
    "legacy weak-password bootstrap",
  );
  console.log("ok - legacy password fixture created before HIBP enforcement");
} else if (phase === "normal") {
  await verifyNormalPolicy();
} else if (phase === "fail-open") {
  const result = await signUp(uniqueEmail("hibp-fail-open"), pwnedPassword);
  await expectStatus(result, 200, "HIBP fail-open signup");
  console.log(
    "ok - HIBP outage allows password creation under fail-open policy",
  );
} else {
  throw new Error(`Unknown Auth policy harness phase: ${phase ?? "<missing>"}`);
}

async function verifyNormalPolicy() {
  const legacyLogin = await passwordGrant(
    requiredValue(legacyEmail, "legacy email"),
    pwnedPassword,
  );
  await expectStatus(legacyLogin, 200, "legacy weak-password login");
  assert(
    hasSession(legacyLogin.data),
    "legacy weak-password login did not return a Session",
  );
  assert(
    hasWeakPasswordReason(legacyLogin.data, "pwned"),
    "legacy weak-password login did not return the pwned signal",
  );
  console.log(
    "ok - a successful legacy weak-password login remains an ordinary Session",
  );

  const tooShort = await signUp(uniqueEmail("too-short"), "abcdefghijk");
  await expectStatus(tooShort, 422, "11-byte signup");
  assertWeakPasswordReason(tooShort.data, "length", "11-byte signup");

  const exactMinimum = await signUp(
    uniqueEmail("exact-minimum"),
    "qzxvplmnbcda",
  );
  await expectStatus(exactMinimum, 200, "12-byte lowercase signup");
  const exactMinimumSession = requireSession(
    exactMinimum.data,
    "12-byte lowercase signup",
  );
  assertJwtLifetime(exactMinimumSession.access_token, 3_600);
  const rotated = await refresh(exactMinimumSession.refresh_token);
  await expectStatus(rotated, 200, "refresh-token rotation");
  const rotatedSession = requireSession(rotated.data, "refresh-token rotation");
  assert(
    rotatedSession.refresh_token !== exactMinimumSession.refresh_token,
    "refresh-token rotation reused the submitted token",
  );
  const descendant = await refresh(rotatedSession.refresh_token);
  await expectStatus(descendant, 200, "refresh-token descendant rotation");
  const descendantSession = requireSession(
    descendant.data,
    "refresh-token descendant rotation",
  );
  ageRefreshToken(exactMinimumSession.refresh_token, 11);
  const reusedAncestor = await refresh(exactMinimumSession.refresh_token);
  await expectStatus(reusedAncestor, 400, "refresh-token ancestor reuse");
  assert(
    authErrorCode(reusedAncestor.data) === "refresh_token_already_used",
    `refresh-token ancestor reuse returned ${summarize(reusedAncestor)}`,
  );
  ageRefreshToken(descendantSession.refresh_token, 11);
  const revokedDescendant = await refresh(descendantSession.refresh_token);
  await expectStatus(
    revokedDescendant,
    400,
    "refresh-token descendant after family revocation",
  );
  console.log(
    "ok - 12-byte lowercase password, one-hour JWT, rotation, and reuse-family revocation are enforced",
  );

  const exactMaximum = await signUp(
    uniqueEmail("exact-maximum"),
    "密".repeat(24),
  );
  await expectStatus(exactMaximum, 200, "72-byte signup");
  const tooLong = await signUp(
    uniqueEmail("too-long"),
    `${"密".repeat(23)}abcd`,
  );
  await expectStatus(tooLong, 400, "73-byte signup");
  assert(
    authErrorCode(tooLong.data) === "validation_failed",
    `73-byte signup returned ${summarize(tooLong)}`,
  );
  console.log(
    "ok - the real Auth service accepts 72 UTF-8 bytes and rejects 73",
  );

  const pwnedSignup = await signUp(uniqueEmail("pwned-signup"), pwnedPassword);
  await expectStatus(pwnedSignup, 422, "pwned-password signup");
  assertWeakPasswordReason(pwnedSignup.data, "pwned", "pwned-password signup");

  const updateSource = await signUp(
    uniqueEmail("pwned-update"),
    `Nevix-safe-update-${randomUUID()}`,
  );
  await expectStatus(updateSource, 200, "password-update fixture signup");
  const updateSession = requireSession(
    updateSource.data,
    "password-update fixture signup",
  );
  const pwnedUpdate = await request("/user", {
    method: "PUT",
    token: updateSession.access_token,
    body: { password: pwnedPassword },
  });
  await expectStatus(pwnedUpdate, 422, "pwned password update");
  assertWeakPasswordReason(pwnedUpdate.data, "pwned", "pwned password update");
  console.log(
    "ok - HIBP rejects leaked passwords during signup and password update",
  );

  const timeboxInside = await createSession("session-timebox-inside");
  ageSession(
    timeboxInside.access_token,
    "created_at = now() - interval '90 days' + interval '1 minute'",
  );
  const timeboxInsideRefresh = await refresh(timeboxInside.refresh_token);
  await expectStatus(
    timeboxInsideRefresh,
    200,
    "just-inside 90-day time-box refresh",
  );
  requireSession(
    timeboxInsideRefresh.data,
    "just-inside 90-day time-box refresh",
  );

  const timeboxOutside = await createSession("session-timebox-outside");
  ageSession(
    timeboxOutside.access_token,
    "created_at = now() - interval '90 days' - interval '1 minute'",
  );
  const timeboxRefresh = await refresh(timeboxOutside.refresh_token);
  await expectStatus(
    timeboxRefresh,
    400,
    "just-outside 90-day time-box refresh",
  );
  assert(
    authErrorCode(timeboxRefresh.data) === "session_expired",
    `just-outside 90-day time-box refresh returned ${summarize(timeboxRefresh)}`,
  );

  const inactivityInside = await createSession("session-inactivity-inside");
  ageSession(
    inactivityInside.access_token,
    "refreshed_at = now() - interval '14 days' + interval '1 minute'",
  );
  const inactivityInsideRefresh = await refresh(inactivityInside.refresh_token);
  await expectStatus(
    inactivityInsideRefresh,
    200,
    "just-inside 14-day inactivity refresh",
  );
  requireSession(
    inactivityInsideRefresh.data,
    "just-inside 14-day inactivity refresh",
  );

  const inactivityOutside = await createSession("session-inactivity-outside");
  ageSession(
    inactivityOutside.access_token,
    "refreshed_at = now() - interval '14 days' - interval '1 minute'",
  );
  const inactivityRefresh = await refresh(inactivityOutside.refresh_token);
  await expectStatus(
    inactivityRefresh,
    400,
    "just-outside 14-day inactivity refresh",
  );
  assert(
    authErrorCode(inactivityRefresh.data) === "session_expired" &&
      authErrorMessage(inactivityRefresh.data).includes("Inactivity"),
    `just-outside 14-day inactivity refresh returned ${summarize(inactivityRefresh)}`,
  );
  console.log(
    "ok - refresh accepts just-inside and rejects just-outside the 14-day inactivity and 90-day absolute Session limits",
  );
}

async function createSession(label) {
  const result = await signUp(uniqueEmail(label), `Nevix-safe-${randomUUID()}`);
  await expectStatus(result, 200, `${label} fixture signup`);
  return requireSession(result.data, `${label} fixture signup`);
}

async function signUp(email, password) {
  return request("/signup", { method: "POST", body: { email, password } });
}

async function passwordGrant(email, password) {
  return request("/token?grant_type=password", {
    method: "POST",
    body: { email, password },
  });
}

async function refresh(refreshToken) {
  return request("/token?grant_type=refresh_token", {
    method: "POST",
    body: { refresh_token: refreshToken },
  });
}

async function request(path, { method, body, token }) {
  const response = await fetch(`${authUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try {
    data = text === "" ? {} : JSON.parse(text);
  } catch {
    data = {};
  }
  return { status: response.status, data };
}

function ageSession(accessToken, assignment) {
  const container = requiredValue(databaseContainer, "database container");
  const sessionId = jwtPayload(accessToken).session_id;
  assert(
    typeof sessionId === "string" && /^[0-9a-f-]{36}$/.test(sessionId),
    "Auth Session did not contain a valid session_id claim",
  );
  execFileSync(
    "docker",
    [
      "exec",
      container,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `update auth.sessions set ${assignment} where id = '${sessionId}'::uuid`,
    ],
    { stdio: "ignore" },
  );
}

function ageRefreshToken(refreshToken, seconds) {
  const container = requiredValue(databaseContainer, "database container");
  assert(
    Number.isInteger(seconds) && seconds > 0,
    "Refresh token age must be a positive integer",
  );
  const tokenLiteral = refreshToken.replaceAll("'", "''");
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    {
      input: `update auth.refresh_tokens set updated_at = now() - interval '${seconds} seconds' where token = '${tokenLiteral}';`,
      stdio: ["pipe", "ignore", "ignore"],
    },
  );
}

function assertJwtLifetime(accessToken, expectedSeconds) {
  const payload = jwtPayload(accessToken);
  assert(
    typeof payload.iat === "number" && typeof payload.exp === "number",
    "Auth access token did not contain numeric iat and exp claims",
  );
  assert(
    payload.exp - payload.iat === expectedSeconds,
    `Auth access token lifetime was ${payload.exp - payload.iat}s, expected ${expectedSeconds}s`,
  );
}

function jwtPayload(token) {
  const payload = token.split(".")[1];
  assert(payload !== undefined, "Auth access token was not a JWT");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

async function expectStatus(result, expected, label) {
  assert(
    result.status === expected,
    `${label} returned ${summarize(result)}, expected HTTP ${expected}`,
  );
}

function assertWeakPasswordReason(data, reason, label) {
  assert(
    hasWeakPasswordReason(data, reason),
    `${label} did not report weak_password:${reason}`,
  );
}

function hasWeakPasswordReason(data, reason) {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof data.weak_password === "object" &&
    data.weak_password !== null &&
    Array.isArray(data.weak_password.reasons) &&
    data.weak_password.reasons.includes(reason)
  );
}

function hasSession(data) {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof data.access_token === "string" &&
    typeof data.refresh_token === "string"
  );
}

function requireSession(data, label) {
  assert(hasSession(data), `${label} did not return a Session`);
  return data;
}

function authErrorCode(data) {
  if (typeof data !== "object" || data === null) return "<missing>";
  if (typeof data.error_code === "string") return data.error_code;
  if (typeof data.code === "string") return data.code;
  return "<missing>";
}

function authErrorMessage(data) {
  if (typeof data !== "object" || data === null) return "";
  if (typeof data.msg === "string") return data.msg;
  if (typeof data.message === "string") return data.message;
  return "";
}

function summarize(result) {
  const reasons =
    typeof result.data === "object" &&
    result.data !== null &&
    typeof result.data.weak_password === "object" &&
    result.data.weak_password !== null &&
    Array.isArray(result.data.weak_password.reasons)
      ? result.data.weak_password.reasons.join(",")
      : "<none>";
  return `HTTP ${result.status}, code ${authErrorCode(result.data)}, weak reasons ${reasons}`;
}

function uniqueEmail(label) {
  return `${label}-${Date.now()}-${randomUUID()}@nevix.test`;
}

function requiredEnvironment(name) {
  return requiredValue(process.env[name], name);
}

function requiredValue(value, name) {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
