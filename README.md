
<img width="1190" alt="sure_hero" src="https://github.com/user-attachments/assets/959f6e9f-2d8a-4f8c-893e-cd3e6eeb4ff2" />

<p align="center">
  <!-- Keep these links. Translations will automatically update with the README. -->
  <a href="https://readme-i18n.com/de/we-promise/sure">Deutsch</a> | 
  <a href="https://readme-i18n.com/es/we-promise/sure">Español</a> | 
  <a href="https://readme-i18n.com/fr/we-promise/sure">Français</a> | 
  <a href="https://readme-i18n.com/ja/we-promise/sure">日本語</a> | 
  <a href="https://readme-i18n.com/ko/we-promise/sure">한국어</a> | 
  <a href="https://readme-i18n.com/pt/we-promise/sure">Português</a> | 
  <a href="https://readme-i18n.com/ru/we-promise/sure">Русский</a> | 
  <a href="https://readme-i18n.com/zh/we-promise/sure">中文</a>
</p>

# Permoney: The personal finance app for everyone (community fork)

<b>Get
involved: [Discord](https://discord.gg/36ZGBsxYEK) • [(archived) Website](https://web.archive.org/web/20250715182050/https://maybefinance.com/) • [Issues](https://github.com/hendripermana/maybe/issues)</b>

> [!IMPORTANT]
> **Legal Disclaimer**: Permoney is a fork of the original Maybe Finance application, which is licensed under the GNU Affero General Public License v3.0. This project is not affiliated with, endorsed by, or connected to Maybe Finance Inc. "Maybe" is a trademark of Maybe Finance Inc. and is not used in this project.
> 
> This repository is a community fork of the now-abandoned Maybe Finance project. 
> Learn more in their [final release](https://github.com/maybe-finance/maybe/releases/tag/v0.6.0) doc.

## Backstory

The Maybe Finance team spent most of 2021–2022 building a full-featured personal finance and wealth management app. It even included an “Ask an Advisor” feature that connected users with a real CFP/CFA — all included with your subscription.

The business end of things didn't work out, and so they stopped developing the app in mid-2023.

After spending nearly $1 million on development (employees, contractors, data providers, infra, etc.), the team open-sourced the app. Their goal was to let users self-host it for free — and eventually launch a hosted version for a small fee.

They actually did launch that hosted version … briefly.

That also didn’t work out — at least not as a sustainable B2C business — so now here we are: hosting a community-maintained fork to keep the codebase alive and see where this can go next.

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

- See `.ruby-version` file for required Ruby version
- PostgreSQL >9.3 (latest stable version recommended)

### Getting Started
```sh
cd sure
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

### Frontend Tooling

- Assets are served by Propshaft with Importmap (no JS bundler).
- Sources:
  - `app/assets/builds` for Tailwind output (`tailwind.css`)
  - `app/javascript` for application JS and Stimulus controllers
  - `vendor/javascript` for pinned third‑party ESM packages
- Stimulus controllers are auto‑registered via `app/javascript/controllers/index.js` using a local loader shim pinned as `@hotwired/stimulus-loading` → `app/javascript/stimulus-loading.js`.

### Troubleshooting: 404s for assets in development

If you see 404s like `/assets/tailwind-*.css` or `/assets/d3-*.js`:

1. Stop `bin/dev` completely.
2. Clear caches: `bin/rails tmp:cache:clear`.
3. Restart: `bin/dev` and hard‑refresh the browser.
4. Ensure paths are present in `config/initializers/assets.rb`:
   - `app/assets/builds`, `app/javascript`, and `vendor/javascript` are in `config.assets.paths`.
5. If importmap looks stale, bump `Rails.application.config.assets.version` and reload.

### Setup Guides

- [Mac dev setup](https://github.com/we-promise/sure/wiki/Mac-Dev-Setup-Guide)
- [Linux dev setup](https://github.com/we-promise/sure/wiki/Linux-Dev-Setup-Guide)
- [Windows dev setup](https://github.com/we-promise/sure/wiki/Windows-Dev-Setup-Guide)
- Dev containers - visit [this guide](https://code.visualstudio.com/docs/devcontainers/containers)

## License and Trademarks

Permoney is distributed under the [AGPLv3 license](LICENSE), maintaining compliance with the original Maybe Finance licensing terms.

**Trademark Notice:**
- "Maybe" is a trademark of Maybe Finance, Inc. and is not used in this project
- "Permoney" is the independent name for this community fork
- This project is not affiliated with, endorsed by, or connected to Maybe Finance Inc.

**AGPLv3 Compliance:**
- Source code is freely available in this repository
- All modifications are clearly documented
- Original license terms are preserved and respected
