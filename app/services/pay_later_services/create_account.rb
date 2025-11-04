module PayLaterServices
  class CreateAccount
    Result = Struct.new(:success?, :account, :error, keyword_init: true)

    def initialize(family:, params:)
      @family = family
      @params = params.is_a?(ActionController::Parameters) ? params.to_h.symbolize_keys : params.symbolize_keys
    end

    def call
      validate!

      account = nil
      ActiveRecord::Base.transaction do
        account = family.accounts.create_and_sync(
          family: family,
          name: params.fetch(:name),
          currency: params[:currency] || family.currency,
          balance: to_d(params[:balance]) || 0,
          accountable_type: "PayLater",
          accountable_attributes: accountable_attrs
        )
      end

      Result.new(success?: true, account: account)
    rescue => e
      Rails.logger.error("PayLater creation failed: #{e.message}")
      # Filter sensitive params before logging
      filtered_params = params.except(:credit_limit, :available_credit, :contract_url, :notes)
      Rails.logger.error("Params: #{filtered_params.inspect}")
      Rails.logger.error(e.backtrace.join("\n"))
      Result.new(success?: false, error: e.message)
    end

    private
      attr_reader :family, :params

      def validate!
        raise ArgumentError, "Missing name" unless params[:name].present?
        limit = to_d(params[:credit_limit])
        avail = to_d(params[:available_credit])
        raise ArgumentError, "Available credit cannot exceed credit limit" if limit && avail && avail > limit
      end

      def accountable_attrs
        {
          provider_name: params[:provider_name],
          credit_limit: to_d(params[:credit_limit]),
          available_credit: to_d(params[:available_credit]),
          free_interest_months: params[:free_interest_months] || 0,
          late_fee_first7: to_d(params[:late_fee_first7]) || 50_000,
          late_fee_per_day: to_d(params[:late_fee_per_day]) || 30_000,
          interest_rate_table: parse_json(params[:interest_rate_table]),
          currency_code: upcase3(params[:currency_code] || params[:currency]),
          exchange_rate_to_idr: to_d(params[:exchange_rate_to_idr]),
          approved_date: parse_date(params[:approved_date]),
          expiry_date: parse_date(params[:expiry_date]),
          max_tenor: to_i(params[:max_tenor]),
          status: params[:status],
          notes: params[:notes],
          auto_update_rate: to_bool(params[:auto_update_rate]),
          contract_url: params[:contract_url],
          grace_days: to_i(params[:grace_days]),
          is_compound: to_bool(params[:is_compound]),
          early_settlement_allowed: to_bool(params[:early_settlement_allowed]),
          early_settlement_fee: to_d(params[:early_settlement_fee]),
          updated_by: params[:updated_by],
          subtype: "paylater"
        }.compact
      end

      def to_d(val)
        return nil if val.nil? || val == ""
        val.to_d
      end

      def parse_json(val)
        return {} if val.blank?
        return val if val.is_a?(Hash)
        JSON.parse(val) rescue {}
      end

      def parse_date(val)
        return val if val.is_a?(Date)
        return nil if val.blank?
        Date.parse(val.to_s)
      rescue ArgumentError
        nil
      end

      def to_bool(val)
        ActiveModel::Type::Boolean.new.cast(val)
      end

      def to_i(val)
        return nil if val.nil? || val == ""
        val.to_i
      end

      def upcase3(code)
        return nil if code.blank?
        code.to_s.upcase[0, 3]
      end
  end
end
