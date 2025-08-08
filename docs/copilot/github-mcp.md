GitHub MCP setup for this repo

Goal
- Make the GitHub Model Context Protocol (MCP) server work against this repo with your own GitHub account.

Prerequisites
- VS Code with Copilot Chat extension (latest)
- GitHub CLI (gh) optional but recommended
- A GitHub token with repo scope in your environment as GITHUB_TOKEN
- An MCP GitHub server binary on PATH (e.g., gh-mcp or similar)

Workspace wiring
- We added .vscode/settings.json with an mcp.servers.github entry pointing at command: gh-mcp and passing env:
  - GITHUB_TOKEN: ${env:GITHUB_TOKEN}
  - GITHUB_REPO_OWNER: hendripermana
  - GITHUB_REPO_NAME: maybe

Steps
1) Install a GitHub MCP server (example)
   - gh extension install (if your MCP server is a gh extension)
   - or download a standalone gh-mcp binary and ensure it’s executable and on PATH
2) Export your token
```bash
export GITHUB_TOKEN=<your_token_with_repo_scope>
```
3) Open this repo folder in VS Code
4) In Copilot Chat, verify the server
   - Ask: "What MCP servers are available?"
   - Then: "Use the github MCP server to list recent PRs"

Troubleshooting
- Command not found gh-mcp: Ensure the binary is on PATH or update .vscode/settings.json mcp.servers.github.command to your binary name.
- Unauthorized (401): Check GITHUB_TOKEN and scopes; restart VS Code window after changing env vars.
- Wrong repo: Adjust GITHUB_REPO_OWNER/NAME env values in settings if you forked the repo.

Security notes
- Do not commit tokens. Use environment variables.
- Limit scopes to what you need (repo is typical).
