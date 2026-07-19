import { isDid } from "@atcute/lexicons/syntax";
import { AuthRequiredError, InvalidRequestError } from "@atcute/xrpc-server";
import * as jose from "jose";
import { z } from "zod";

const ACCESS_SCOPE = "com.atproto.access";
const REFRESH_SCOPE = "com.atproto.refresh";

const didSchema = z.string().refine(isDid);

const accessTokenShapeSchema = z.object({
	sub: didSchema,
	aud: didSchema,
	lxm: z.undefined(),
	cnf: z.undefined(),
});
const accessScopeSchema = z.object({ scope: z.literal(ACCESS_SCOPE) });

const refreshTokenShapeSchema = z.object({
	sub: didSchema,
	lxm: z.undefined(),
	cnf: z.undefined(),
});
const jtiSchema = z.object({ jti: z.string() });
const refreshScopeSchema = z.object({ scope: z.literal(REFRESH_SCOPE) });

export type AuthContext = {
	jwtKey: Uint8Array;
	serviceDid: string;
};

export function createJwtKey(secret: string): Uint8Array {
	return new TextEncoder().encode(secret);
}

export function createAccessToken(
	did: string,
	{ jwtKey, serviceDid }: AuthContext,
): Promise<string> {
	return new jose.SignJWT({ scope: ACCESS_SCOPE })
		.setProtectedHeader({ typ: "at+jwt", alg: "HS256" })
		.setAudience(serviceDid)
		.setSubject(did)
		.setIssuedAt()
		.setExpirationTime("120mins")
		.sign(jwtKey);
}

export async function createRefreshToken(
	did: string,
	{ jwtKey, serviceDid }: AuthContext,
): Promise<{ jwt: string; jti: string }> {
	const jti = crypto.randomUUID();
	const jwt = await new jose.SignJWT({ scope: REFRESH_SCOPE })
		.setProtectedHeader({ typ: "refresh+jwt", alg: "HS256" })
		.setAudience(serviceDid)
		.setSubject(did)
		.setJti(jti)
		.setIssuedAt()
		.setExpirationTime("90days")
		.sign(jwtKey);
	return { jwt, jti };
}

export async function createTokens(
	did: string,
	auth: AuthContext,
): Promise<{ accessJwt: string; refreshJwt: string; refreshJti: string }> {
	const [accessJwt, { jwt: refreshJwt, jti: refreshJti }] = await Promise.all([
		createAccessToken(did, auth),
		createRefreshToken(did, auth),
	]);
	return { accessJwt, refreshJwt, refreshJti };
}

export async function verifyAccessToken(
	request: Request,
	{ jwtKey, serviceDid }: AuthContext,
): Promise<{ sub: string }> {
	const token = bearerTokenFromRequest(request);
	if (!token) throw new AuthRequiredError({ error: "AuthMissing" });

	const { payload } = await jose
		.jwtVerify(token, jwtKey, { audience: serviceDid, typ: "at+jwt" })
		.catch((cause) => {
			if (cause instanceof jose.errors.JWTExpired) {
				throw new InvalidRequestError({
					error: "ExpiredToken",
					message: "Token has expired",
				});
			}
			throw new InvalidRequestError({
				error: "InvalidToken",
				message: "Token could not be verified",
			});
		});

	const shapeResult = accessTokenShapeSchema.safeParse(payload);
	if (!shapeResult.success) {
		throw new InvalidRequestError({
			error: "InvalidToken",
			message: "Malformed token",
		});
	}
	const scopeResult = accessScopeSchema.safeParse(payload);
	if (!scopeResult.success) {
		throw new InvalidRequestError({
			error: "InvalidToken",
			message: "Bad token scope",
		});
	}

	return { sub: shapeResult.data.sub };
}

export async function verifyRefreshToken(
	request: Request,
	{ jwtKey, serviceDid }: AuthContext,
	options?: { allowExpired?: boolean },
): Promise<{ sub: string; jti: string }> {
	const token = bearerTokenFromRequest(request);
	if (!token) throw new AuthRequiredError({ error: "AuthMissing" });

	const { payload } = await jose
		.jwtVerify(token, jwtKey, {
			audience: serviceDid,
			typ: "refresh+jwt",
			clockTolerance: options?.allowExpired
				? Number.POSITIVE_INFINITY
				: undefined,
		})
		.catch((cause) => {
			if (cause instanceof jose.errors.JWTExpired) {
				throw new InvalidRequestError({
					error: "ExpiredToken",
					message: "Token has expired",
				});
			}
			throw new InvalidRequestError({
				error: "InvalidToken",
				message: "Token could not be verified",
			});
		});

	const shapeResult = refreshTokenShapeSchema.safeParse(payload);
	if (!shapeResult.success) {
		throw new InvalidRequestError({
			error: "InvalidToken",
			message: "Malformed token",
		});
	}
	const jtiResult = jtiSchema.safeParse(payload);
	if (!jtiResult.success) {
		throw new InvalidRequestError({
			error: "InvalidToken",
			message: "Missing token id",
		});
	}
	const scopeResult = refreshScopeSchema.safeParse(payload);
	if (!scopeResult.success) {
		throw new InvalidRequestError({
			error: "InvalidToken",
			message: "Bad token scope",
		});
	}

	return { sub: shapeResult.data.sub, jti: jtiResult.data.jti };
}

export function bearerTokenFromRequest(request: Request): string | null {
	const authorization = request.headers.get("authorization");
	if (!authorization) return null;
	const parts = authorization.split(" ");
	if (parts.length !== 2) return null;
	if (parts[0].toUpperCase() !== "BEARER") return null;
	return parts[1];
}
