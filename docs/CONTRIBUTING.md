# API

## Contributing

Thank you for your interest in contributing!
We welcome contributions from the community to help improve the platform and its resources.
Whether you're a developer, designer, writer, or simply someone with ideas to share, we encourage you to get involved.

However there are jurisdictional restrictions on who can contribute to the project and what it means to contribute.
In short all your contributions must be your own original work, and you must have the right to transfer the rights to the project.
By submitting a contribution, you agree to grant the project a non-exclusive, worldwide, royalty-free license to use, modify, and distribute your contribution.

Please see the [LICENSE](../LICENSE) file for more information on the licensing terms.

## Guidelines

- Keep changes focused and minimal. If possible, split unrelated work into separate pull requests.
- Follow existing project structure, naming, and style conventions.
- Update documentation when behavior, commands, or workflows change.
- Ensure your contribution is your own original work and does not include unlicensed third-party content.
- Write clear commit messages and pull request descriptions that explain **what** changed and **why**.
- Before opening a PR, run project checks (formatting, linting, and tests) and fix issues.
- Prefer small, reviewable PRs over large multi-purpose changes.
- Be respectful and constructive in reviews and discussions.

Other guidelines are provided in the [File-Specific Guidelines](./CONTRIBUTING/FILE_SPECIFIC_GUIDELINES.md) file.

## Contribution Handbook

Use the articles below for detailed, task-specific contributor guidance.

| Filename                                                                  | Description                                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [FOLDER_STRUCTURE.md](./CONTRIBUTING/FOLDER_STRUCTURE.md)                 | General overview of the repository structure and purpose of each folder.       |
| [FILE_SPECIFIC_GUIDELINES.md](./CONTRIBUTING/FILE_SPECIFIC_GUIDELINES.md) | Guidelines for contributing to specific files and folders.                     |
| [ARCHITECTURE.md](./CONTRIBUTING/ARCHITECTURE.md)                         | How the four surfaces fit together, and the design rules they follow.          |
| [API_FOLDER.md](./CONTRIBUTING/API_FOLDER.md)                             | The `api/` folder convention: filenames, route modules, and shared schemas.    |
| [TYPE_MAPPING.md](./CONTRIBUTING/TYPE_MAPPING.md)                         | Which TypeScript maps to which OpenAPI, and the JSDoc tags that fill the gaps. |
| [SERVER.md](./CONTRIBUTING/SERVER.md)                                     | Reference for `@plushveil/api/server`.                                         |
| [CLI.md](./CONTRIBUTING/CLI.md)                                           | Reference for the `api-port` and `api-backport` commands.                      |
| [CLIENT.md](./CONTRIBUTING/CLIENT.md)                                     | Reference for `@plushveil/api/client`.                                         |
| [RELEASE.md](./RELEASE.md)                                                | Tagging, what CD publishes, and the container image.                           |

## Development Environment

This repository includes a development container configuration to provide a consistent setup.

Recommended setup:

1. Install Docker.
2. Install an editor with Dev Containers support (for example, VS Code + Dev Containers extension).
3. Open the repository and choose **Reopen in Container** when prompted.

Using the devcontainer ensures you use the same tooling and versions expected by the project (shell tooling, language/runtime dependencies, and common CLI utilities).

If you are not using Dev Containers, mirror the toolchain defined in `.devcontainer/` as closely as possible, then run the same local checks before submitting a PR.

### Local Dev Server Quick Start

To run the local dev server, use the following command:

```bash
npm start
```
