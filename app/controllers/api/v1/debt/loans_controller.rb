class Api::V1::Debt::LoansController < Api::V1::BaseController
  # Preview is read-only; write scope required for mutation endpoints
  before_action -> { authorize_scope!("write") }, only: [ :post_installment, :regenerate ]

  # POST /api/v1/debt/loans/plan/preview
  def preview
    # Scoped to current family to prevent unauthorized access
    account_id = params.require(:account_id)
    account = Current.family.accounts.find(account_id)
    unless account.accountable_type == "Loan"
      return render json: { error: "account_id must reference a Loan account" }, status: :unprocessable_entity
    end

    principal_param = params.require(:principal_amount)
    tenor_param = params.require(:tenor_months)
    principal = BigDecimal(principal_param.to_s)
    tenor = tenor_param.to_i

    return render json: { error: "principal_amount must be > 0" }, status: :unprocessable_entity if principal <= 0
    return render json: { error: "tenor_months must be > 0" }, status: :unprocessable_entity if tenor <= 0

    rate = Loan.normalize_rate(params[:rate_or_profit].presence || account.accountable.interest_rate || account.accountable.margin_rate || 0)
    freq = (params[:payment_frequency] || account.accountable.payment_frequency || "MONTHLY").to_s
    method = (params[:schedule_method] || account.accountable.schedule_method || "ANNUITY").to_s
    start = params[:start_date].presence || account.accountable.origination_date || Date.current
    day_count = params[:day_count].presence
    if day_count.present?
      allowed = [ "30E/360", "ACT/365", "ACT/ACT" ]
      return render json: { error: "Unsupported day_count. Allowed: #{allowed.join(', ')}" }, status: :unprocessable_entity unless allowed.include?(day_count)
    end

    begin
      rows = Loan::ScheduleGenerator.new(
        principal_amount: principal,
        rate_or_profit: rate,
        tenor_months: tenor,
        payment_frequency: freq,
        schedule_method: method,
        start_date: start,
        balloon_amount: params[:balloon_amount].presence&.to_d || account.accountable.balloon_amount || 0,
        loan_id: account.accountable_id
      ).generate

      # Ensure rows is properly initialized before processing
      return render json: { error: "Failed to generate schedule" }, status: :unprocessable_entity if rows.nil? || rows.empty?

      sum_p = rows.sum { |r| r.principal.to_d }
      sum_i = rows.sum { |r| r.interest.to_d }
      sum_t = rows.sum { |r| r.total.to_d }
      rounding_note = (principal - sum_p).abs <= 0.01 ? nil : "Rounding adjustments applied to last row"

      render json: {
        count: rows.size,
        rows: rows.map { |r| { due_date: r.due_date, principal: r.principal.to_s, interest: r.interest.to_s, total: r.total.to_s } },
        totals: { principal: sum_p.to_s, interest: sum_i.to_s, total: sum_t.to_s },
        rounding_note: rounding_note,
        day_count: day_count
      }
    rescue ArgumentError => e
      Rails.logger.error({ at: "API::Loans.preview.error", account_id: account&.id, error: e.message }.to_json)
      render json: { error: e.message }, status: :unprocessable_entity
    end
  end
  def post_installment
    result = Loan::PostInstallment.new(
      family: Current.family,
      account_id: params.require(:account_id),
      source_account_id: params.require(:source_account_id),
      installment_no: params[:installment_no],
      date: params[:date],
      late_fee: params[:late_fee]
    ).call!

    if result.success?
      render json: { transfer_id: result.transfer.id, installment_no: result.installment.installment_no, posted_on: result.installment.posted_on }, status: :ok
    else
      render json: { error: result.error }, status: :unprocessable_entity
    end
  end

  # POST /api/v1/debt/loans/plan/regenerate
  def regenerate
    # Scoped to current family to prevent unauthorized access
    account_id = params.require(:account_id)
    account = Current.family.accounts.find(account_id)
    unless account.accountable_type == "Loan"
      return render json: { error: "account_id must reference a Loan account" }, status: :unprocessable_entity
    end

    principal = (params[:principal_amount] || account.accountable.principal_amount || account.accountable.initial_balance || account.balance).to_d
    tenor = (params[:tenor_months] || account.accountable.tenor_months).to_i
    rate = Loan.normalize_rate(params[:rate_or_profit].presence || account.accountable.rate_or_profit || account.accountable.interest_rate || account.accountable.margin_rate || 0)
    freq = (params[:payment_frequency] || account.accountable.payment_frequency || "MONTHLY").to_s
    method = (params[:schedule_method] || account.accountable.schedule_method || "ANNUITY").to_s
    start = params[:start_date].presence || account.accountable.start_date || Date.current
    balloon = params[:balloon_amount].presence&.to_d || account.accountable.balloon_amount || 0

    return render json: { error: "principal_amount must be > 0" }, status: :unprocessable_entity if principal <= 0
    return render json: { error: "tenor_months must be > 0" }, status: :unprocessable_entity if tenor <= 0

    res = Loan::PlanBuilder.call!(
      account: account,
      principal_amount: principal,
      rate_or_profit: rate,
      tenor_months: tenor,
      payment_frequency: freq,
      schedule_method: method,
      start_date: start,
      balloon_amount: balloon
    )
    if res.success?
      next_due = account.loan_installments.pending.order(:due_date).first&.due_date
      render json: { regenerated_count: res.installments.size, next_due_date: next_due }, status: :ok
    else
      render json: { error: res.error }, status: :unprocessable_entity
    end
  end
end
