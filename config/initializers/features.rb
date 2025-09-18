Rails.application.config.features = ActiveSupport::OrderedOptions.new
Rails.application.config.features.loans = ActiveSupport::OrderedOptions.new
Rails.application.config.features.loans.borrowed = ActiveSupport::OrderedOptions.new
Rails.application.config.features.loans.borrowed.enabled = true
Rails.application.config.features.loans.extra_payment = ActiveModel::Type::Boolean.new.cast(ENV.fetch("FEATURES_LOANS_EXTRA_PAYMENT", "false"))
