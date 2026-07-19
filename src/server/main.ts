import { XRPCRouter } from "@atcute/xrpc-server";
import { cors } from "@atcute/xrpc-server/middlewares/cors";
import { createDenoWebSocket } from "@atcute/xrpc-server-deno";
import { Secp256k1Keypair } from "@atproto/crypto";
import { Repo } from "@atproto/repo";
import { GitHubRepoStorage } from "../blockstore/github.ts";
import { createJwtKey } from "./auth.ts";
import { Firehose } from "./firehose.ts";
import { registerRepoHandlers } from "./handler.ts";
import { createProxyMiddleware } from "./proxy.ts";
import type { RepoContext } from "./repo.ts";
import { registerSessionHandlers } from "./session.ts";
import { registerSyncHandlers } from "./sync.ts";

function getEnv(name: string, fallback?: string): string {
	const value = Deno.env.get(name) ?? fallback;
	if (value === undefined) throw new Error(`missing required env var: ${name}`);
	return value;
}

const GITHUB_TOKEN = getEnv("GITHUB_TOKEN");
const GITHUB_OWNER = getEnv("GITHUB_OWNER");
const GITHUB_REPO = getEnv("GITHUB_REPO");
const GITHUB_BRANCH = getEnv("GITHUB_BRANCH", "main");
const REPO_DID = getEnv("REPO_DID");
const REPO_HANDLE = getEnv("REPO_HANDLE");
const REPO_SIGNING_KEY_HEX = getEnv("REPO_SIGNING_KEY");
const JWT_SECRET = getEnv("JWT_SECRET");
const ADMIN_PASSWORD = getEnv("ADMIN_PASSWORD");
const PORT = Number(getEnv("PORT", "8080"));

console.log(
	"[main] initializing storage:",
	GITHUB_OWNER,
	GITHUB_REPO,
	GITHUB_BRANCH,
);
const storage = new GitHubRepoStorage(
	GITHUB_TOKEN,
	GITHUB_OWNER,
	GITHUB_REPO,
	GITHUB_BRANCH,
);
const keypair = await Secp256k1Keypair.import(REPO_SIGNING_KEY_HEX);
console.log("[main] loading repo root");
const root = await storage.getRoot();
const repo = root
	? await Repo.load(storage, root)
	: await Repo.create(storage, REPO_DID, keypair);
const ctx: RepoContext = { repo, keypair, storage };
console.log("[main] repo ready:", ctx.repo.did);

const auth = { jwtKey: createJwtKey(JWT_SECRET), serviceDid: REPO_DID };

const initialSeq = await storage.getSeq();
const kv = await Deno.openKv();
const firehose = new Firehose(initialSeq, storage, kv);
const ws = createDenoWebSocket();

const router = new XRPCRouter({ websocket: ws, middlewares: [cors()] });
registerRepoHandlers(router, ctx, firehose, REPO_HANDLE, auth);
registerSessionHandlers(router, auth, REPO_HANDLE, ADMIN_PASSWORD);
registerSyncHandlers(router, firehose, ctx);

const handler = createProxyMiddleware(
	router.fetch.bind(router),
	REPO_DID,
	keypair,
	auth,
);
console.log("[main] starting server on port:", PORT);
Deno.serve({ port: PORT }, handler);
