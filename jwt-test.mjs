import { jwtVerify } from "jose-cjs";

const BASE = "http://localhost";

async function main() {
  const sign = await fetch(`${BASE}:3000/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ email: "kitagawa@gmail.com", password: "Kitagawa12345" }),
  });
  const jar = sign.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

  const ex = await fetch(`${BASE}:5000/api/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: jar },
  });
  const exSet = ex.headers.getSetCookie();
  console.log("exchange set-cookie:", exSet);
  const token = exSet[0].split(";")[0].split("=")[1];
  console.log("token len:", token.length);

  const secret = new TextEncoder().encode("7UhbyK5YBFqHKHJkEd1UR90zB0qsDhWb");
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    console.log("JWT valid. sub:", payload.sub, "role:", payload.role, "exp:", payload.exp);
  } catch (e) {
    console.log("JWT verify failed:", e.message);
  }
}

main();
