import dotenv from "dotenv";
import { signInternalRequest } from "@chat-siris/logger";

dotenv.config();

function usage(): never {
  console.error("Usage: npm run sign -- <path> [METHOD]");
  console.error("");
  console.error("Examples:");
  console.error("  npm run sign -- /internal/users/6a1882ebeb62f0968b509ee2");
  console.error("  npm run sign -- /internal/users POST");
  process.exit(1);
}

const pathArg = process.argv[2];
if (!pathArg) {
  usage();
}

const maybeMethod = process.argv[3]?.toUpperCase();
const knownMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

let method = "GET";
let path = pathArg;

if (maybeMethod && knownMethods.has(maybeMethod)) {
  method = maybeMethod;
} else if (maybeMethod) {
  console.error(`Unknown method "${maybeMethod}". Use GET, POST, PUT, PATCH, or DELETE.`);
  process.exit(1);
}

if (!path.startsWith("/")) {
  path = `/${path}`;
}

const secret = process.env.INTERNAL_HMAC_SECRET;
if (!secret) {
  console.error("INTERNAL_HMAC_SECRET is not set in .env");
  process.exit(1);
}

const { signature, timestamp } = signInternalRequest(method, path, secret);

console.log(JSON.stringify(
  {
    method,
    path,
    headers: {
      "X-Internal-Timestamp": String(timestamp),
      "X-Internal-Signature": signature,
    },
  },
  null,
  2,
));
