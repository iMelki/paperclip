# GitHub OAuth scopes for Projects import

Paperclip's native GitHub OAuth connection (Apps > Connect GitHub OAuth) uses a classic
GitHub OAuth App. Classic OAuth scopes cannot be limited to single repositories, so
Paperclip asks for the least access that the board import needs and makes broader
access an explicit choice.

| Tier | Requested scopes | What it allows |
|---|---|---|
| Default | `read:project`, `public_repo`, `offline_access` | Read user and organization Projects. Issues and contents in public repositories only. No private repository access. |
| Private repositories (opt-in) | `repo`, `project`, `offline_access` | Full read and write on every private repository the authorizing account can reach, plus Project writes. |

Why these scopes (see GitHub's
[Scopes for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)):

- The board import only reads Projects, so `read:project` is enough. `project` is
  requested only on the opt-in tier, where Project field writes are also expected.
- `public_repo` is the narrowest classic scope that reaches public repository issues.
- Reading issues from private repositories on a board needs `repo`. GitHub has no
  narrower classic scope for that, so `repo` is requested only when the operator ticks
  "Include private repositories" on the connect form (stored as
  `githubPrivateRepoAccess: true` on the connection; any other value means the default).
- `offline_access` keeps the expiring-token refresh behavior in both tiers.

The server verifies the scopes GitHub actually granted (token response and the
`X-OAuth-Scopes` header) against the tier. A broader grant (`repo` or `project`)
satisfies the default tier. A default-tier grant never satisfies the private tier.
To change tiers, create a new connection and authorize again.
