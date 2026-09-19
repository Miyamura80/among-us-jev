# among-us-jev

<p align="center">
  <img src="media/banner.png" alt="Among-Us-Jev" width="400">
</p>

<p align="center">
<b>AI agent that plays Among Us using JEV from Typesafe AI</b>
</p>

<p align="center">
  <a href="#key-features">Key Features</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#credits">Credits</a> •
  <a href="#about-the-core-contributors">About the Core Contributors</a>
</p>

<p align="center">
  <img alt="Project Version" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FMiyamura80%2FAmong-Us-Jev%2Fmain%2Fpackage.json&query=%24.version&label=version&color=blue">
  <img alt="Bun" src="https://img.shields.io/badge/runtime-bun-f9f1e1?logo=bun">
  <img alt="GitHub repo size" src="https://img.shields.io/github/repo-size/Miyamura80/among-us-jev">
  <img alt="GitHub Actions Workflow Status" src="https://img.shields.io/github/actions/workflow/status/Miyamura80/among-us-jev/ci_checks.yaml?branch=main">
</p>

---

<p align="center">
  <img src="media/demo.gif" alt="Among-Us-Jev Demo" width="600">
</p>

## Key Features

| Feature | Description |
|---------|-------------|
| **Bun runtime** | Fast TypeScript execution and package management |
| **Zod config** | YAML + env var config with Zod schema validation |
| **Biome** | Linting and formatting |
| **knip** | Dead code and unused dependency detection |
| **dependency-cruiser** | Module boundary enforcement |
| **jscpd** | Duplicate code detection |
| **prek** | Pre-commit hooks |
| **Vite + React** | Frontend app |

## Quick Start

```bash
# Interactive onboarding
make onboard

# Install dependencies and run
make all

# Format code
make fmt

# Run tests
make test

# Run all CI checks (lint, deadcode, typecheck, etc.)
make ci
```

## Configuration

Config is loaded from YAML with environment variable overrides:

```typescript
import { globalConfig } from "@/config";

// Access config values from src/config/global-config.yaml
globalConfig.exampleParent.exampleChild;

// Access secrets from .env
globalConfig.openaiApiKey;

// Feature flags (overridable via FEATURES__FLAG_NAME=true)
globalConfig.features.newUi;
```

**Precedence** (highest to lowest):
1. Environment variables (with `__` for nesting, e.g. `DEFAULT_LLM__DEFAULT_MAX_TOKENS=50000`)
2. `.global-config.yaml` (local override, git-ignored)
3. `src/config/production-config.yaml` (if `DEV_ENV=prod`)
4. `src/config/global-config.yaml` (base config)

## Credits

- [Bun](https://bun.sh) - JavaScript runtime and package manager
- [Biome](https://biomejs.dev) - Linter and formatter
- [Zod](https://zod.dev) - TypeScript schema validation
- [prek](https://github.com/j178/prek) - Pre-commit hook framework

## About the Core Contributors

<a href="https://github.com/Miyamura80/among-us-jev/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Miyamura80/among-us-jev" />
</a>

Made with [contrib.rocks](https://contrib.rocks).
