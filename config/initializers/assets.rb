# Be sure to restart your server when you modify this file.

# Version of your assets, change this if you want to expire all your assets.
Rails.application.config.assets.version = "1.0"

# Add additional assets to the asset load path.
# Tailwind outputs compiled CSS to app/assets/builds; Propshaft should serve it.
Rails.application.config.assets.paths << Rails.root.join("app/assets/builds")

# Exclude Tailwind source files from Propshaft to avoid digesting inputs.
Rails.application.config.assets.excluded_paths << Rails.root.join("app/assets/tailwind")
