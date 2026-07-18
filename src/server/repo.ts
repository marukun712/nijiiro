import type { Keypair } from "@atproto/crypto";
import type { Repo } from "@atproto/repo";
import type { GitHubRepoStorage } from "../blockstore/github.ts";

export type RepoContext = {
	repo: Repo;
	keypair: Keypair;
	storage: GitHubRepoStorage;
};
