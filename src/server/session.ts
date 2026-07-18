// https://github.com/bluesky-social/atproto/blob/main/packages/pds/src/api/com/atproto/server/
import {
	ComAtprotoServerCreateSession,
	ComAtprotoServerDeleteSession,
	ComAtprotoServerDescribeServer,
	ComAtprotoServerGetSession,
	ComAtprotoServerRefreshSession,
} from "@atcute/atproto";
import { isDid, isHandle } from "@atcute/lexicons/syntax";
import type { XRPCRouter } from "@atcute/xrpc-server";
import {
	AuthRequiredError,
	InvalidRequestError,
	json,
} from "@atcute/xrpc-server";
import type { AuthContext } from "./auth.ts";
import { createTokens, verifyAccessToken, verifyRefreshToken } from "./auth.ts";

const REVOKED_JTI_PREFIX = "revoked_jti";
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function registerSessionHandlers(
	router: XRPCRouter,
	auth: AuthContext,
	handle: string,
	password: string,
	kv: Deno.Kv,
) {
	if (!isDid(auth.serviceDid)) {
		throw new Error(`configured DID is invalid: ${auth.serviceDid}`);
	}
	if (!isHandle(handle)) {
		throw new Error(`configured handle is invalid: ${handle}`);
	}
	const did = auth.serviceDid;
	const validHandle = handle;
	router.addQuery(ComAtprotoServerDescribeServer.mainSchema, {
		handler() {
			return json({
				did,
				availableUserDomains: [],
			});
		},
	});

	router.addProcedure(ComAtprotoServerCreateSession.mainSchema, {
		async handler({ input }) {
			const { identifier, password: inputPassword } = input;

			if (
				(identifier !== validHandle && identifier !== did) ||
				inputPassword !== password
			) {
				throw new AuthRequiredError({
					message: "Invalid identifier or password",
				});
			}

			const { accessJwt, refreshJwt } = await createTokens(did, auth);

			return json({
				accessJwt,
				refreshJwt,
				did,
				handle: validHandle,
				active: true,
			});
		},
	});

	router.addQuery(ComAtprotoServerGetSession.mainSchema, {
		async handler({ request }) {
			await verifyAccessToken(request, auth);

			return json({
				did,
				handle: validHandle,
				active: true,
			});
		},
	});

	router.addProcedure(ComAtprotoServerRefreshSession.mainSchema, {
		async handler({ request }) {
			const { sub, jti } = await verifyRefreshToken(request, auth);

			const revoked = await kv.get([REVOKED_JTI_PREFIX, jti]);
			if (revoked.value !== null) {
				throw new InvalidRequestError({
					error: "ExpiredToken",
					message: "Token has been revoked",
				});
			}

			await kv.set([REVOKED_JTI_PREFIX, jti], true, {
				expireIn: REFRESH_TOKEN_TTL_MS,
			});

			const { accessJwt, refreshJwt } = await createTokens(sub, auth);

			return json({
				accessJwt,
				refreshJwt,
				did,
				handle: validHandle,
				active: true,
			});
		},
	});

	router.addProcedure(ComAtprotoServerDeleteSession.mainSchema, {
		async handler({ request }) {
			const { jti } = await verifyRefreshToken(request, auth, {
				allowExpired: true,
			});

			await kv.set([REVOKED_JTI_PREFIX, jti], true, {
				expireIn: REFRESH_TOKEN_TTL_MS,
			});
		},
	});
}
