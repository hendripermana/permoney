# frozen_string_literal: true

# Loan Configuration Service
# Handles all configurable settings for the loan system
# to ensure flexibility and maintainability
class LoanConfigurationService
  CONFIG_PATH = Rails.root.join('config', 'loan_settings.yml')

  class << self
    def config
      @config ||= load_config
    end

    def reload_config!
      @config = load_config
    end

    # Default values
    def default_tenor_months
      config.dig('defaults', 'tenor_months') || 12
    end

    def default_payment_frequency
      config.dig('defaults', 'payment_frequency') || 'MONTHLY'
    end

    def default_schedule_method
      config.dig('defaults', 'schedule_method') || 'ANNUITY'
    end

    # Validation bounds
    def min_tenor_months
      config.dig('defaults', 'min_tenor_months') || 1
    end

    def max_tenor_months
      config.dig('defaults', 'max_tenor_months') || 480
    end

    def min_rate
      config.dig('defaults', 'min_rate') || 0
    end

    def max_rate
      config.dig('defaults', 'max_rate') || 100
    end

    def min_profit_sharing_ratio
      config.dig('defaults', 'min_profit_sharing_ratio') || 0
    end

    def max_profit_sharing_ratio
      config.dig('defaults', 'max_profit_sharing_ratio') || 1
    end

    # Payment frequencies
    def payment_frequencies
      config['payment_frequencies'] || {}
    end

    def supported_payment_frequencies
      payment_frequencies.keys
    end

    def payment_frequency_config(frequency)
      payment_frequencies[frequency]
    end

    def payment_frequency_label(frequency)
      payment_frequency_config(frequency)&.dig('label') || frequency.humanize
    end

    # Schedule methods
    def schedule_methods
      config['schedule_methods'] || {}
    end

    def supported_schedule_methods
      schedule_methods.keys
    end

    def schedule_method_config(method)
      schedule_methods[method]
    end

    def schedule_method_label(method)
      schedule_method_config(method)&.dig('label') || method.humanize
    end

    # Field configurations
    def field_config(field_name)
      config.dig('form_fields', field_name.to_s) || {}
    end

    def field_precision(field_type)
      config.dig('defaults', 'field_precision', field_type.to_s) || 2
    end

    # Validation rules
    def validation_rules(field_name)
      config.dig('validation_rules', field_name.to_s) || []
    end

    # Notification settings
    def reminder_days
      config.dig('defaults', 'reminder_days') || {}
    end

    def notification_templates
      config['notification_templates'] || {}
    end

    def notification_template(category, type)
      notification_templates.dig(category.to_s, type.to_s)
    end

    # Feature flags
    def feature_enabled?(feature_name)
      config.dig('features', feature_name.to_s, 'enabled') || false
    end

    def feature_description(feature_name)
      config.dig('features', feature_name.to_s, 'description') || ''
    end

    # Integration settings
    def integration_enabled?(integration_name)
      config.dig('integrations', integration_name.to_s, 'enabled') || false
    end

    def integration_config(integration_name)
      config.dig('integrations', integration_name.to_s) || {}
    end

    # Performance settings
    def performance_config
      config['performance'] || {}
    end

    def max_installments_preview
      performance_config['max_installments_preview'] || 100
    end

    def calculation_timeout
      performance_config['calculation_timeout'] || 30
    end

    def cache_ttl(key)
      performance_config.dig('cache_ttl', key.to_s) || 300
    end

    # Dynamic configuration methods
    def set_config_value(path, value)
      keys = path.split('.')
      current = config

      keys[0..-2].each do |key|
        current[key] ||= {}
        current = current[key]
      end

      current[keys.last] = value
      save_config
    end

    def get_config_value(path, default = nil)
      keys = path.split('.')
      current = config

      keys.each do |key|
        return default unless current&.key?(key)
        current = current[key]
      end

      current || default
    end

    private

    def load_config
      if File.exist?(CONFIG_PATH)
        # Keep keys as strings so all config.dig('...') calls remain consistent
        YAML.safe_load(File.read(CONFIG_PATH)).deep_stringify_keys
      else
        # Return default configuration if file doesn't exist
        Rails.logger.warn("Loan configuration file not found at #{CONFIG_PATH}. Using defaults.")
        generate_default_config.deep_stringify_keys
      end
    rescue => e
      Rails.logger.error("Error loading loan configuration: #{e.message}. Using defaults.")
      generate_default_config.deep_stringify_keys
    end

    def save_config
      File.write(CONFIG_PATH, config.deep_stringify_keys.to_yaml)
    end

    def generate_default_config
      {
        'defaults' => {
          'tenor_months' => 12,
          'payment_frequency' => 'MONTHLY',
          'schedule_method' => 'ANNUITY',
          'min_tenor_months' => 1,
          'max_tenor_months' => 480,
          'min_rate' => 0,
          'max_rate' => 100,
          'min_profit_sharing_ratio' => 0,
          'max_profit_sharing_ratio' => 1,
          'field_precision' => {
            'interest_rate' => 3,
            'margin_rate' => 3,
            'profit_sharing_ratio' => 2,
            'money_fields' => 2
          },
          'reminder_days' => {
            'urgent' => 0,
            'high' => '1..3',
            'medium' => '4..7'
          }
        },
        'payment_frequencies' => {
          'MONTHLY' => { 'months_interval' => 1, 'label' => 'Monthly' },
          'QUARTERLY' => { 'months_interval' => 3, 'label' => 'Quarterly' },
          'SEMI_ANNUALLY' => { 'months_interval' => 6, 'label' => 'Semi-annually' },
          'ANNUALLY' => { 'months_interval' => 12, 'label' => 'Annually' }
        },
        'schedule_methods' => {
          'ANNUITY' => { 'calculation_type' => 'annuity', 'label' => 'Equal Installments' },
          'FLAT' => { 'calculation_type' => 'flat', 'label' => 'Equal Principal' },
          'EFFECTIVE' => { 'calculation_type' => 'effective', 'label' => 'Effective Rate' }
        },
        'features' => {
          'wizard_form' => { 'enabled' => true },
          'sharia_compliance' => { 'enabled' => true },
          'extra_payments' => { 'enabled' => true },
          'partial_payments' => { 'enabled' => true },
          'advanced_calculations' => { 'enabled' => true },
          'notifications' => { 'enabled' => true }
        },
        'performance' => {
          'max_installments_preview' => 100,
          'calculation_timeout' => 30,
          'cache_ttl' => {
            'installment_schedules' => 300,
            'payment_calculations' => 60,
            'form_configurations' => 3600
          }
        }
      }
    end
  end
end
