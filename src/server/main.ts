import { XRPCRouter } from "@atcute/xrpc-server";
import { Secp256k1Keypair } from "@atproto/crypto";
import { Repo } from "@atproto/repo";
import { GitHubRepoStorage } from "../blockstore/github.ts";
import { registerRepoHandlers } from "./handler.ts";
import type { RepoContext } from "./repo.ts";

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

const storage = new GitHubRepoStorage(
	GITHUB_TOKEN,
	GITHUB_OWNER,
	GITHUB_REPO,
	GITHUB_BRANCH,
);
const keypair = await Secp256k1Keypair.import(REPO_SIGNING_KEY_HEX);
const root = await storage.getRoot();
const repo = root
	? await Repo.load(storage, root)
	: await Repo.create(storage, REPO_DID, keypair);
const ctx: RepoContext = { repo, keypair, storage };

const router = new XRPCRouter();
registerRepoHandlers(router, ctx, REPO_HANDLE);

Deno.serve({ port: 8000 }, router.fetch);
