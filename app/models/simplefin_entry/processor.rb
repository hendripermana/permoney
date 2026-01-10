require "digest/md5"

class SimplefinEntry::Processor
  include CurrencyNormalizable
  # simplefin_transaction is the raw hash fetched from SimpleFin API and converted to JSONB
  def initialize(simplefin_transaction, simplefin_account:)
    @simplefin_transaction = simplefin_transaction
    @simplefin_account = simplefin_account
  end

  def process
    import_adapter.import_transaction(
      external_id: external_id,
      amount: amount,
      currency: currency,
      date: date,
      name: name,
      source: "simplefin",
      merchant: merchant,
      notes: notes,
      extra: extra_metadata
    )
  end

  private
    attr_reader :simplefin_transaction, :simplefin_account

    def extra_metadata
      sf = {}
      # Preserve raw strings from provider so nothing is lost
      sf["payee"] = data[:payee] if data.key?(:payee)
      sf["memo"] = data[:memo] if data.key?(:memo)
      sf["description"] = data[:description] if data.key?(:description)
      # Include provider-supplied extra hash if present
      sf["extra"] = data[:extra] if data[:extra].is_a?(Hash)

      # Pending detection: explicit flag OR inferred from posted=0 + transacted_at
      # SimpleFIN indicates pending via:
      # 1. pending: true (explicit flag)
      # 2. posted=0 (epoch zero) + transacted_at present (implicit - some banks use this pattern)
      #
      # Note: We only infer from posted=0, NOT from posted=nil/blank, because some providers
      # don't supply posted dates even for settled transactions (would cause false positives).
      # We always set the key (true or false) to ensure deep_merge overwrites any stale value
      is_pending = if ActiveModel::Type::Boolean.new.cast(data[:pending])
        true
      else
        # Infer pending ONLY when posted is explicitly 0 (epoch) AND transacted_at is present
        # posted=nil/blank is NOT treated as pending (some providers omit posted for settled txns)
        posted_val = data[:posted]
        transacted_val = data[:transacted_at]
        posted_is_epoch_zero = posted_val.present? && posted_val.to_i.zero?
        transacted_present = transacted_val.present? && transacted_val.to_i > 0
        posted_is_epoch_zero && transacted_present
      end

      if is_pending
        sf["pending"] = true
        Rails.logger.debug("SimpleFIN: flagged pending transaction #{external_id}")
      else
        sf["pending"] = false
      end

      tx_currency = parse_currency(data[:currency])
      acct_currency = account.currency
      if tx_currency.present? && acct_currency.present? && tx_currency != acct_currency
        sf["fx_from"] = tx_currency
        # Prefer transacted_at for fx date, fallback to posted
        fx_date = transacted_date || posted_date
        sf["fx_date"] = fx_date&.to_s
      end

      return nil if sf.empty?
      { "simplefin" => sf }
    end

    def import_adapter
      @import_adapter ||= Account::ProviderImportAdapter.new(account)
    end

    def account
      simplefin_account.current_account
    end

    def data
      @data ||= simplefin_transaction.with_indifferent_access
    end

    def external_id
      id = data[:id].presence
      raise ArgumentError, "SimpleFin transaction missing id: #{data.inspect}" unless id
      "simplefin_#{id}"
    end

    def name
      # Use SimpleFin's rich, clean data to create informative transaction names
      payee = data[:payee]
      description = data[:description]

      # Combine payee + description when both are present and different
      if payee.present? && description.present? && payee != description
        "#{payee} - #{description}"
      elsif payee.present?
        payee
      elsif description.present?
        description
      else
        data[:memo] || "Unknown transaction"
      end
    end

    def amount
      parsed_amount = case data[:amount]
      when String
        BigDecimal(data[:amount])
      when Numeric
        BigDecimal(data[:amount].to_s)
      else
        BigDecimal("0")
      end

      -parsed_amount
    rescue ArgumentError => e
      Rails.logger.error "Failed to parse SimpleFin transaction amount: #{data[:amount].inspect} - #{e.message}"
      raise
    end

    def currency
      parse_currency(data[:currency]) || account.currency
    end

    def date
      acct_type = simplefin_account&.account_type.to_s.strip.downcase.tr(" ", "_")
      if %w[credit_card credit loan mortgage].include?(acct_type)
        transacted_date || posted_date || invalid_date!
      else
        posted_date || transacted_date || invalid_date!
      end
    end

    def posted_date
      val = data[:posted]
      return nil if val == 0 || val == "0"
      parse_provider_date(val)
    end

    def transacted_date
      parse_provider_date(data[:transacted_at])
    end

    def parse_provider_date(value)
      return nil if value.blank?

      case value
      when Date
        value
      when Time, DateTime
        value.to_date
      when Integer
        return nil if value <= 0
        Time.at(value).to_date
      when Float
        return nil if value <= 0
        Time.at(value).to_date
      when String
        stripped = value.strip
        return nil if stripped.empty?
        if stripped.match?(/\A-?\d+\z/)
          int_val = stripped.to_i
          return nil if int_val <= 0
          Time.at(int_val).to_date
        else
          Date.parse(stripped)
        end
      else
        nil
      end
    rescue ArgumentError, TypeError => e
      Rails.logger.error("Failed to parse SimpleFin transaction date '#{value}': #{e.message}")
      nil
    end

    def invalid_date!
      Rails.logger.error("SimpleFin transaction missing posted/transacted date: #{data.inspect}")
      raise ArgumentError, "Invalid date format: #{data[:posted].inspect} / #{data[:transacted_at].inspect}"
    end


    def merchant
      # Use SimpleFin's clean payee data for merchant detection
      payee = data[:payee]&.strip
      return nil unless payee.present?

      @merchant ||= import_adapter.find_or_create_merchant(
        provider_merchant_id: generate_merchant_id(payee),
        name: payee,
        source: "simplefin"
      )
    rescue ActiveRecord::RecordInvalid => e
      Rails.logger.error "SimplefinEntry::Processor - Failed to create merchant '#{payee}': #{e.message}"
      nil
    end

    def generate_merchant_id(merchant_name)
      # Generate a consistent ID for merchants without explicit IDs
      "simplefin_#{Digest::MD5.hexdigest(merchant_name.downcase)}"
    end

    def notes
      memo = data[:memo].to_s.strip
      payee = data[:payee].to_s.strip
      description = data[:description].to_s.strip

      parts = []
      parts << memo if memo.present?
      if payee.present? && payee != description
        parts << "Payee: #{payee}"
      end
      parts.presence&.join(" | ")
    end

    def log_invalid_currency(currency_value)
      Rails.logger.warn("Invalid currency code '#{currency_value}' in SimpleFIN transaction #{external_id}, falling back to account currency")
    end
end
