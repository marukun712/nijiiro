import {
	ComAtprotoServerCreateSession,
	ComAtprotoServerDescribeServer,
	ComAtprotoServerGetSession,
	ComAtprotoServerRefreshSession,
} from "@atcute/atproto";
import { isDid, isHandle } from "@atcute/lexicons/syntax";
import type { XRPCRouter } from "@atcute/xrpc-server";
import { AuthRequiredError, json } from "@atcute/xrpc-server";
import type { AuthContext } from "./auth.ts";
import { createTokens, verifyAccessToken, verifyRefreshToken } from "./auth.ts";

export function registerSessionHandlers(
	router: XRPCRouter,
	auth: AuthContext,
	handle: string,
	password: string,
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
			const { sub } = await verifyRefreshToken(request, auth);
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
}
