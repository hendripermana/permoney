require_relative "production"

Rails.application.configure do
  # Inherit all production settings; staging differs via environment toggles.

  # Optionally enable features via ENV (safe defaults)
  config.after_initialize do
    if Rails.application.config.respond_to?(:features)
      features = Rails.application.config.features
      features.loans.extra_payment = ActiveModel::Type::Boolean.new.cast(ENV["FEATURES_LOANS_EXTRA_PAYMENT"]) if features.dig(:loans, :extra_payment) != nil
    end
  end
end
