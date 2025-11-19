Rails.application.config.after_initialize do
  # Ensure all provider adapters are loaded so their configurations are registered
  Provider::Factory.ensure_adapters_loaded

  # Reload configuration for all registered providers
  # This ensures that global configurations (like Plaid.config) are set up on boot
  Provider::ConfigurationRegistry.all.each do |config|
    adapter_class = Provider::ConfigurationRegistry.get_adapter_class(config.provider_key)
    adapter_class&.reload_configuration
  end
end
