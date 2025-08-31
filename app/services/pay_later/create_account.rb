module PayLater
  class CreateAccount
    Result = Struct.new(:success?, :account, :error, keyword_init: true)

    def initialize(family:, params:)
      @family = family
      @params = params.deep_symbolize_keys
    end

    def call
      validate!

      account = nil
      ActiveRecord::Base.transaction do
        account = family.accounts.create_and_sync(
          family: family,
          name: params.fetch(:name),
          currency: params[:currency] || family.currency,
          balance: 0,
          accountable_type: "PayLater",
          accountable_attributes: accountable_attrs
        )
      end

      Result.new(success?: true, account: account)
    rescue => e
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
  end
end

