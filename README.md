# paprika-3-mcp (hardened fork)

Fork of [soggycactus/paprika-3-mcp](https://github.com/soggycactus/paprika-3-mcp). Changes in this fork:

- **Tools instead of resources.** `search_paprika_recipes` and `get_paprika_recipe` replace the MCP resources, which many clients don't surface. The old background loop that re-downloaded every recipe once a minute is gone; search keeps an index and only refetches recipes whose hash changed.
- **Safe updates.** `update_paprika_recipe` loads the current recipe and changes only the fields you pass. Photo, rating, categories, created date and any fields Paprika adds later are kept. `append_notes` adds to notes without replacing them. Trashed recipes are never updated.
- **No delete tool.**
- **Credentials from environment only**: `PAPRIKA_USERNAME` and `PAPRIKA_PASSWORD`. The `-username` / `-password` flags are removed so the password never appears in a process list. The login form is URL-encoded, so passwords with `&`, `+` or `=` work.
- **Logs to stderr** (Claude Desktop captures it). The lumberjack dependency is removed.
- Unit tests for update merging, search and the cache (`go test ./...`). The original live API test needs `-tags live`.

## Node version (for Windows with Smart App Control)

Smart App Control blocks unsigned executables, including the Go build. `node/paprika-mcp.js` is the same server as one file with no dependencies, run by the signed `node.exe` (Node 18+). Same four tools, same merge-only updates, no delete tool, credentials from env, only contacts paprikaapp.com. Tests: `node --test node/paprika-mcp.test.js`.

```json
"paprika": {
  "command": "node",
  "args": ["C:\\Users\\<you>\\.local\\bin\\paprika-mcp.js"],
  "env": { "PAPRIKA_USERNAME": "you@example.com", "PAPRIKA_PASSWORD": "set this yourself" }
}
```

## Claude Desktop config (Windows, Go build)

```json
{
  "mcpServers": {
    "paprika": {
      "command": "C:\\Users\\<you>\\bin\\paprika-3-mcp.exe",
      "env": {
        "PAPRIKA_USERNAME": "you@example.com",
        "PAPRIKA_PASSWORD": "set this yourself"
      }
    }
  }
}
```

---

Original README follows. Its tool list and `-username`/`-password` install steps no longer apply to this fork.

# paprika-3-mcp

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/introduction) server that exposes your **Paprika 3** recipes as LLM-readable resources — and lets an LLM like Claude create or update recipes in your Paprika app.

### 🖼️ Example: Claude using the Paprika MCP server

<p align="center">
  <img src="docs/example.png" alt="MCP server running with Claude" />
</p>

## 🚀 Features

See anything missing? Open an issue on this repo to request a feature!

#### 📄 **Resources**

- Recipes ✅
- Recipe Photos 🚧

#### 🛠 **Tools**

- `create_paprika_recipe`  
  Allows Claude to save a new recipe to your Paprika app
- `update_paprika_recipe`  
  Allows Claude to modify an existing recipe

## ⚙️ Prerequisites

- ✅ A Mac, Linux, or Windows system
- ✅ [Paprika 3](https://www.paprikaapp.com/) installed with cloud sync enabled
- ✅ Your Paprika 3 **username and password**
- ✅ Claude or any LLM client with **MCP tool support** enabled

## 🛠 Installation

You can download a prebuilt binary from the [Releases](https://github.com/soggycactus/paprika-3-mcp/releases) page.

### 🍎 macOS (via Homebrew)

If you're on macOS, the easiest way to install is with [Homebrew](https://brew.sh/):

```bash
brew tap soggycactus/tap
brew install paprika-3-mcp
```

### 🐧 Linux / 🪟 Windows

1. Go to the [latest release](https://github.com/soggycactus/paprika-3-mcp/releases).
2. Download the appropriate archive for your operating system and architecture:
   - `paprika-3-mcp_<version>_linux_amd64.zip` for Linux
   - `paprika-3-mcp_<version>_windows_amd64.zip` for Windows
3. Extract the zip archive:
   - **Linux**:
     ```bash
     unzip paprika-3-mcp_<version>_<os>_<arch>.zip
     ```
   - **Windows**:
     - Right-click the `.zip` file and select **Extract All**, or use a tool like 7-Zip.
4. Move the binary to a directory in your system's `$PATH`:

   - Linux:

     ```bash
     sudo mv paprika-3-mcp /usr/local/bin/
     ```

   - Windows:
     - Move `paprika-3-mcp.exe` to any folder in your `PATH` (e.g., `%USERPROFILE%\bin`)

### ✅ Test the installation

You can verify the server is installed by checking:

```bash
paprika-3-mcp --version
```

You should see:

```bash
paprika-3-mcp version v0.1.0
```

## 🤖 Setting up Claude

If you haven't setup MCP before, [first read more about how to install Claude Desktop client & configure an MCP server.](https://modelcontextprotocol.io/quickstart/user)

To add `paprika-3-mcp` to Claude, all you need to do is create another entry in the `mcpServers` section of your `claude_desktop_config.json` file:

```json
{
  "mcpServers": {
    "paprika-3": {
      "command": "paprika-3-mcp",
      "args": [
        "--username",
        "<your paprika 3 username (usually email)>",
        "--password",
        "<your paprika 3 password>"
      ]
    }
  }
}
```

Restart Claude and you should see the MCP server tools after clicking on the hammerhead icon:

![MCP server running with Claude](docs/install.png)

## 📄 License

This project is open source under the [MIT License](./LICENSE) © 2025 [Lucas Stephens](https://github.com/soggycactus).

---

#### 🗂 Miscellaneous

##### 📄 Where can I see the server logs?

The MCP server writes structured logs using Go’s `slog` with rotation via `lumberjack`. Log files are automatically created based on your operating system:

| Operating System | Log File Path                             |
| ---------------- | ----------------------------------------- |
| macOS            | `~/Library/Logs/paprika-3-mcp/server.log` |
| Linux            | `/var/log/paprika-3-mcp/server.log`       |
| Windows          | `%APPDATA%\paprika-3-mcp\server.log`      |
| Other / Unknown  | `/tmp/paprika-3-mcp/server.log`           |

> 💡 Logs are rotated automatically at 100MB, with only 5 backup files kept. Logs are also wiped after 10 days.
