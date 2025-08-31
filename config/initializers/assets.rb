# Be sure to restart your server when you modify this file.

# Version of your assets, change this if you want to expire all your assets.
# Bump asset version to invalidate stale digested paths in development
Rails.application.config.assets.version = "1.1"

# Add additional assets to the asset load path.
# Ensure Propshaft can resolve local JS modules (Importmap pins under app/javascript/**/*)
Rails.application.config.assets.paths << Rails.root.join("app/javascript")
# TailwindCSS build output
Rails.application.config.assets.paths << Rails.root.join("app/assets/builds")
# Importmap vendor packages
Rails.application.config.assets.paths << Rails.root.join("vendor/javascript")
Rails.application.config.assets.paths << "app/components"
Rails.application.config.importmap.cache_sweepers << Rails.root.join("app/components")
Rails.application.config.importmap.cache_sweepers << Rails.root.join("app/javascript/controllers")
Rails.application.config.importmap.cache_sweepers << Rails.root.join("app/javascript/hooks")
Rails.application.config.importmap.cache_sweepers << Rails.root.join("app/javascript/lib")
Rails.application.config.importmap.cache_sweepers << Rails.root.join("app/javascript/components")
Rails.application.config.importmap.cache_sweepers << Rails.root.join("app/javascript/services")
Rails.application.config.importmap.cache_sweepers << Rails.root.join("vendor/javascript")
Rails.application.config.importmap.cache_sweepers << Rails.root.join("app/assets/builds")
