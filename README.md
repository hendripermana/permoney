
<img width="1190" alt="permoney_hero" src="https://github.com/user-attachments/assets/959f6e9f-2d8a-4f8c-893e-cd3e6eeb4ff2" />

<p align="center">
  <!-- Keep these links. Translations will automatically update with the README. -->
  <a href="https://readme-i18n.com/de/hendripermana/permoney">Deutsch</a> | 
  <a href="https://readme-i18n.com/es/hendripermana/permoney">Español</a> | 
  <a href="https://readme-i18n.com/fr/hendripermana/permoney">Français</a> | 
  <a href="https://readme-i18n.com/ja/hendripermana/permoney">日本語</a> | 
  <a href="https://readme-i18n.com/ko/hendripermana/permoney">한국어</a> | 
  <a href="https://readme-i18n.com/pt/hendripermana/permoney">Português</a> | 
  <a href="https://readme-i18n.com/ru/hendripermana/permoney">Русский</a> | 
  <a href="https://readme-i18n.com/zh/hendripermana/permoney">中文</a>
</p>

# Permoney: The personal finance app for everyone

<b>Get
involved: [Discord](https://discord.gg/36ZGBsxYEK) • [(archived) Website](https://web.archive.org/web/20250715182050/https://maybefinance.com/) • [Issues](https://github.com/hendripermana/permoney/issues)</b>

> [!IMPORTANT]
> **Legal Disclaimer**: Permoney is a fork of the original Maybe Finance application, which is licensed under the GNU Affero General Public License v3.0. This project is not affiliated with, endorsed by, or connected to Maybe Finance Inc. "Maybe" is a trademark of Maybe Finance Inc. and is not used in this project.
> 
> This repository is a community fork of the now-abandoned Maybe Finance project. 
> Learn more in their [final release](https://github.com/maybe-finance/maybe/releases/tag/v0.6.0) doc.

## Backstory

The Maybe Finance team spent most of 2021–2022 building a full-featured personal finance and wealth management app. It even included an "Ask an Advisor" feature that connected users with a real CFP/CFA — all included with your subscription.

The business end of things didn't work out, and so they stopped developing the app in mid-2023.

After spending nearly $1 million on development (employees, contractors, data providers, infra, etc.), the team open-sourced the app. Their goal was to let users self-host it for free — and eventually launch a hosted version for a small fee.

They actually did launch that hosted version … briefly.

That also didn't work out — at least not as a sustainable B2C business — so now here we are: hosting a community-maintained fork to keep the codebase alive and see where this can go next.

Join us!

## Hosting Permoney

Permoney is a fully working personal finance app that can be [self hosted with Docker](docs/hosting/docker.md).

## Forking and Attribution

This repo is a community fork of the archived Maybe Finance repo, rebranded as **Permoney**. It replaces the discontinued Synth data provider with pluggable alternatives (Twelve Data, Alpha Vantage) to restore market data, exchange rates, and net worth chart functionality.

**Important Legal Notice:**
- Permoney is based on the original Maybe Finance codebase but is completely independent and not affiliated with Maybe Finance Inc.
- This project complies with the AGPLv3 license requirements
- All "Maybe" branding and trademarks have been removed and replaced with "Permoney"
- The original AGPLv3 license is preserved and included in this repository

You're free to fork it under the AGPLv3 license — but we'd love it if you stuck around and contributed here instead.

## Local Development Setup

**If you are trying to _self-host_ the app, [read this guide to get started](docs/hosting/docker.md).**

The instructions below are for developers to get started with contributing to the app.

### Requirements

- Ruby 3.4.7 (see `.ruby-version` file)
- Bundler 2.7.2
- RubyGems 3.7.2
- PostgreSQL >9.3 (latest stable version recommended)
- Node.js (for frontend tooling)

### Getting Started
```sh
cd permoney
cp .env.local.example .env.local
bin/setup
bin/dev

# Optionally, load demo data
rake demo_data:default
```

Visit http://localhost:3000 to view the app. You can log in with these demo credentials (from the DB seed):

- Email: `user@permoney.local`
- Password: `password`

For further instructions, see guides below.

### Setup Guides

- [Mac dev setup](https://github.com/hendripermana/permoney/wiki/Mac-Dev-Setup-Guide)
- [Linux dev setup](https://github.com/hendripermana/permoney/wiki/Linux-Dev-Setup-Guide)
- [Windows dev setup](https://github.com/hendripermana/permoney/wiki/Windows-Dev-Setup-Guide)
- Dev containers - visit [this guide](https://code.visualstudio.com/docs/devcontainers/containers)

## License and Trademarks

Permoney is distributed under the [AGPLv3 license](LICENSE), maintaining compliance with the original Maybe Finance licensing terms.

**Trademark Notice:**
- "Maybe" is a trademark of Maybe Finance, Inc. and is not used in this project
- "Permoney" is the independent name for this community fork
- This project is not affiliated with, endorsed by, or connected to Maybe Finance Inc.

**AGPLv3 Compliance:**
- Source code is freely available in this repository
- All modifications are shared under the same license
- Network use triggers source code sharing requirements
- Full license text available in [LICENSE](LICENSE) file

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

## Support

- **Documentation**: [docs/](docs/)
- **Issues**: [GitHub Issues](https://github.com/hendripermana/permoney/issues)
- **Discussions**: [GitHub Discussions](https://github.com/hendripermana/permoney/discussions)
- **Discord**: [Join our community](https://discord.gg/36ZGBsxYEK)

## Acknowledgments

- Original Maybe Finance team for open-sourcing this excellent codebase
- Community contributors who keep the project alive
- All the data providers and services that make this app possible

