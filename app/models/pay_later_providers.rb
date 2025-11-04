# Configuration for major Indonesian BNPL providers
# Based on market data as of 2024-2025
class PayLaterProviders
  PROVIDERS = {
      "kredivo" => {
        name: "Kredivo",
        default_currency: "IDR",
        max_tenor: 12,
        free_interest_months: 1,
        interest_rates: {
          "default" => {
            "1" => 0.0,      # 0% for 1 month (promotional)
            "3" => 0.0295,   # 2.95% per month
            "6" => 0.0395,   # 3.95% per month
            "12" => 0.0263   # 2.63% per month
          }
        },
        late_fee_structure: {
          first_7: 50_000,
          per_day: 30_000
        },
        early_settlement: {
          allowed: true,
          fee_percent: 0,
          fee_fixed: 0
        },
        grace_days: 0,
        is_compound: false,
        compliance_type: "conventional",
        features: {
          instant_approval: true,
          flexible_payment: true,
          merchant_network: "wide",
          virtual_card: true
        }
      },

      "akulaku" => {
        name: "Akulaku",
        default_currency: "IDR",
        max_tenor: 12,
        free_interest_months: 0,
        interest_rates: {
          "default" => {
            "1" => 0.025,    # 2.5% per month
            "3" => 0.03,     # 3% per month
            "6" => 0.035,    # 3.5% per month
            "12" => 0.03     # 3% per month
          }
        },
        late_fee_structure: {
          first_7: 100_000,
          per_day: 50_000
        },
        early_settlement: {
          allowed: true,
          fee_percent: 0.01,  # 1% early settlement fee
          fee_fixed: 0
        },
        grace_days: 3,
        is_compound: false,
        compliance_type: "conventional",
        features: {
          instant_approval: true,
          flexible_payment: true,
          merchant_network: "wide",
          cashback_program: true
        }
      },

      "atome" => {
        name: "Atome",
        default_currency: "IDR",
        max_tenor: 12,
        free_interest_months: 3,  # 0% for 3 months (common promo)
        interest_rates: {
          "default" => {
            "3" => 0.0,      # 0% for 3 months promo
            "6" => 0.025,    # 2.5% per month
            "12" => 0.02     # 2% per month
          }
        },
        late_fee_structure: {
          first_7: 75_000,
          per_day: 40_000
        },
        early_settlement: {
          allowed: true,
          fee_percent: 0,
          fee_fixed: 0
        },
        grace_days: 0,
        is_compound: false,
        compliance_type: "conventional",
        features: {
          instant_approval: true,
          qr_payment: true,
          merchant_network: "premium",
          lifestyle_focus: true
        }
      },

      "indodana" => {
        name: "Indodana",
        default_currency: "IDR",
        max_tenor: 12,
        free_interest_months: 0,
        interest_rates: {
          "default" => {
            "3" => 0.03,     # 3% per month
            "6" => 0.035,    # 3.5% per month
            "12" => 0.03     # 3% per month
          }
        },
        late_fee_structure: {
          first_7: 50_000,
          per_day: 25_000
        },
        early_settlement: {
          allowed: true,
          fee_percent: 0,
          fee_fixed: 0
        },
        grace_days: 0,
        is_compound: false,
        compliance_type: "conventional",
        features: {
          instant_approval: true,
          flexible_payment: true,
          merchant_network: "wide"
        }
      },

      "shopee_paylater" => {
        name: "SPayLater (Shopee)",
        default_currency: "IDR",
        max_tenor: 12,
        free_interest_months: 1,
        interest_rates: {
          "default" => {
            "1" => 0.0,      # 0% for PayLater Next Month
            "3" => 0.03,     # 3% per month for installments
            "6" => 0.025,    # 2.5% per month
            "12" => 0.025    # 2.5% per month
          }
        },
        late_fee_structure: {
          first_7: 50_000,
          per_day: 20_000
        },
        early_settlement: {
          allowed: true,
          fee_percent: 0,
          fee_fixed: 0
        },
        grace_days: 0,
        is_compound: false,
        compliance_type: "conventional",
        features: {
          instant_approval: true,
          shopee_ecosystem: true,
          merchant_network: "wide",
          cashback_integration: true
        }
      },

      "gopay_later" => {
        name: "GoPayLater",
        default_currency: "IDR",
        max_tenor: 6,
        free_interest_months: 1,
        interest_rates: {
          "default" => {
            "1" => 0.0,      # 0% for PayLater
            "3" => 0.0,      # 0% for 3 months (promo)
            "6" => 0.02      # 2% per month
          }
        },
        late_fee_structure: {
          first_7: 50_000,
          per_day: 30_000
        },
        early_settlement: {
          allowed: true,
          fee_percent: 0,
          fee_fixed: 0
        },
        grace_days: 0,
        is_compound: false,
        compliance_type: "conventional",
        features: {
          instant_approval: true,
          gojek_ecosystem: true,
          merchant_network: "wide",
          multi_service: true
        }
      },

      "traveloka_paylater" => {
        name: "Traveloka PayLater",
        default_currency: "IDR",
        max_tenor: 12,
        free_interest_months: 0,
        interest_rates: {
          "default" => {
            "3" => 0.025,    # 2.5% per month
            "6" => 0.025,    # 2.5% per month
            "12" => 0.02     # 2% per month
          },
          "travel" => {      # Special rates for travel bookings
            "3" => 0.015,    # 1.5% per month
            "6" => 0.015,    # 1.5% per month
            "12" => 0.015    # 1.5% per month
          }
        },
        late_fee_structure: {
          first_7: 100_000,
          per_day: 50_000
        },
        early_settlement: {
          allowed: false,
          fee_percent: 0,
          fee_fixed: 0
        },
        grace_days: 0,
        is_compound: false,
        compliance_type: "conventional",
        features: {
          instant_approval: true,
          travel_focus: true,
          merchant_network: "travel_focused",
          points_integration: true
        }
      },

      "ovo_paylater" => {
        name: "OVO PayLater",
        default_currency: "IDR",
        max_tenor: 6,
        free_interest_months: 0,
        interest_rates: {
          "default" => {
            "1" => 0.025,    # 2.5% per month
            "3" => 0.03,     # 3% per month
            "6" => 0.025     # 2.5% per month
          }
        },
        late_fee_structure: {
          first_7: 50_000,
          per_day: 25_000
        },
        early_settlement: {
          allowed: true,
          fee_percent: 0,
          fee_fixed: 0
        },
        grace_days: 0,
        is_compound: false,
        compliance_type: "conventional",
        features: {
          instant_approval: true,
          ovo_ecosystem: true,
          merchant_network: "wide",
          points_cashback: true
        }
      },

      # Sharia-compliant BNPL option
      "alami_syariah" => {
        name: "Alami Syariah",
        default_currency: "IDR",
        max_tenor: 12,
        free_interest_months: 0,
        interest_rates: {
          "default" => {
            "3" => 0.02,     # 2% margin (Murabaha)
            "6" => 0.025,    # 2.5% margin
            "12" => 0.02     # 2% margin
          }
        },
        late_fee_structure: {
          first_7: 0,        # No late fees in Sharia finance
          per_day: 0         # Ta'zir (penalty) can be donated to charity
        },
        early_settlement: {
          allowed: true,
          fee_percent: 0,    # Early payment encouraged in Islam
          fee_fixed: 0
        },
        grace_days: 3,
        is_compound: false,
        compliance_type: "sharia",
        features: {
          instant_approval: false,
          sharia_compliant: true,
          merchant_network: "moderate",
          islamic_finance: true,
          murabaha_contract: true
        }
      }
    }.freeze

  # Get all providers as hash for JSON serialization
  def self.all_providers
    PROVIDERS
  end

  # Get provider configuration
  def self.get_provider(provider_key)
    PROVIDERS[provider_key.to_s.downcase]
  end

  # Get list of provider names for dropdown
  def self.provider_options
    PROVIDERS.map { |key, config| [ config[:name], key ] }
  end

  # Get Sharia-compliant providers
  def self.sharia_providers
    PROVIDERS.select { |_key, config| config[:compliance_type] == "sharia" }
  end

  # Get conventional providers
  def self.conventional_providers
    PROVIDERS.select { |_key, config| config[:compliance_type] == "conventional" }
  end

  # Apply provider preset to PayLater instance
  def self.apply_preset(pay_later, provider_key)
    config = get_provider(provider_key)
    return unless config

    pay_later.assign_attributes(
      provider_name: config[:name],
      max_tenor: config[:max_tenor],
      free_interest_months: config[:free_interest_months],
      interest_rate_table: config[:interest_rates],
      late_fee_first7: config[:late_fee_structure][:first_7],
      late_fee_per_day: config[:late_fee_structure][:per_day],
      early_settlement_allowed: config[:early_settlement][:allowed],
      early_settlement_fee: config[:early_settlement][:fee_fixed],
      grace_days: config[:grace_days],
      is_compound: config[:is_compound],
      compliance_type: config[:compliance_type],
      currency_code: config[:default_currency]
    )
  end
end
