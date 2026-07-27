import {
	ComAtprotoServerCreateSession,
	ComAtprotoServerDescribeServer,
	ComAtprotoServerGetSession,
	ComAtprotoServerRefreshSession,
} from "@atcute/atproto";
import { isDid, isHandle } from "@atcute/lexicons/syntax";
import type { XRPCRouter } from "@atcute/xrpc-server";
import { AuthRequiredError, json } from "@atcute/xrpc-server";
import type { AuthContext } from "../services/auth.ts";
import {
	createTokens,
	verifyAccessToken,
	verifyRefreshToken,
} from "../services/auth.ts";
import { withErrorLog } from "../util.ts";

export function registerServerHandlers(
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
		handler: () =>
			withErrorLog("describeServer", () =>
				Promise.resolve(
					json({
						did,
						availableUserDomains: [],
					}),
				),
			),
	});

	router.addProcedure(ComAtprotoServerCreateSession.mainSchema, {
		handler: ({ input }) =>
			withErrorLog("createSession", async () => {
				const { identifier, password: inputPassword } = input;
				console.log("[session] createSession attempt:", identifier);

				if (
					(identifier !== validHandle && identifier !== did) ||
					inputPassword !== password
				) {
					console.log("[session] createSession failed: invalid credentials");
					throw new AuthRequiredError({
						message: "Invalid identifier or password",
					});
				}

				const { accessJwt, refreshJwt } = await createTokens(did, auth);
				console.log("[session] createSession success:", did);

				return json({
					accessJwt,
					refreshJwt,
					did,
					handle: validHandle,
					active: true,
				});
			}),
	});

	router.addQuery(ComAtprotoServerGetSession.mainSchema, {
		handler: ({ request }) =>
			withErrorLog("getSession", async () => {
				await verifyAccessToken(request, auth);

				return json({
					did,
					handle: validHandle,
					active: true,
				});
			}),
	});

	router.addProcedure(ComAtprotoServerRefreshSession.mainSchema, {
		handler: ({ request }) =>
			withErrorLog("refreshSession", async () => {
				console.log("[session] refreshSession");
				const { sub } = await verifyRefreshToken(request, auth);
				const { accessJwt, refreshJwt } = await createTokens(sub, auth);

				return json({
					accessJwt,
					refreshJwt,
					did,
					handle: validHandle,
					active: true,
				});
			}),
	});
}
