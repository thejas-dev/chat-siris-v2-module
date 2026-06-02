import bcrypt from "bcryptjs";

const BCRYPT_PREFIX = "$2";

export function isBcryptHash(value: string): boolean {
  return value.startsWith(BCRYPT_PREFIX);
}

export async function hashPassword(password: string): Promise<string> {
  if (isBcryptHash(password)) {
    return password;
  }
  return bcrypt.hash(password, 10);
}

export async function verifyChannelPassword(
  stored: string | undefined,
  provided: string | undefined,
): Promise<boolean> {
  if (!stored) {
    return true;
  }
  if (provided === undefined || provided === "") {
    return true;
  }
  if (isBcryptHash(stored)) {
    return bcrypt.compare(provided, stored);
  }
  return stored === provided;
}

export function passwordWrongResponse(): { status: false; msg: string } {
  return { status: false, msg: "Password Wrong" };
}
