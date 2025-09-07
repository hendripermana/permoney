class PersonalLendingsController < ApplicationController
  include AccountableResource, StreamExtensions

  permitted_accountable_attributes(
    :id, :counterparty_name, :lending_direction, :lending_type, :expected_return_date,
    :actual_return_date, :agreement_notes, :witness_name, :reminder_frequency,
    :initial_amount, :relationship, :has_written_agreement, :contact_info
  )

  # Build new account and prepare funding source list (cash accounts only)
  def new
    super
    prepare_new_form_state
  end

  # Create Personal Lending with required funding transfer
  def create
    attrs = account_params.except(:return_to)
    funding = funding_params
    nested = attrs[:accountable_attributes] ||= {}

    funding_amount = nested[:initial_amount].presence || attrs[:balance]
    funding_date   = Date.current

    if funding[:source_account_id].blank? || funding_amount.blank?
      @error_message = "Funding source and loan amount are required"
      @account = Current.family.accounts.build(account_params.merge(accountable: PersonalLending.new))
      prepare_new_form_state
      render :new, status: :unprocessable_entity and return
    end

    ApplicationRecord.transaction do
      # Initialize with zero to avoid double counting; transfer establishes balance
      attrs[:balance] = 0

      @account = Current.family.accounts.create_and_sync(attrs)
      @account.update!(subtype: @account.accountable.lending_type)

      result = PersonalLending::AdditionalLendingService.call!(
        family: Current.family,
        params: {
          personal_lending_account_id: @account.id,
          source_account_id: funding[:source_account_id],
          amount: funding_amount,
          date: funding_date,
          notes: funding[:notes]
        }
      )

      unless result.success?
        @error_message = result.error
        raise ActiveRecord::Rollback
      end
    end

    # Only redirect with success if the account actually persisted.
    if @account&.persisted?
      redirect_to @account, notice: t("accounts.create.success", type: "Personal Lending")
    else
      @error_message ||= "Failed to create Personal Lending account"
      @account ||= Current.family.accounts.build(account_params.merge(accountable: PersonalLending.new))
      prepare_new_form_state
      render :new, status: :unprocessable_entity
    end
  rescue ActiveRecord::RecordInvalid => e
    @error_message = e.record.errors.full_messages.join(", ")
    @account ||= Current.family.accounts.build(account_params.merge(accountable: PersonalLending.new))
    prepare_new_form_state
    render :new, status: :unprocessable_entity
  rescue ActiveRecord::Rollback
    @account ||= Current.family.accounts.build(account_params.merge(accountable: PersonalLending.new))
    prepare_new_form_state
    render :new, status: :unprocessable_entity
  end

  def new_payment
    @account = Current.family.accounts.find(params[:id])
    # For payments, we always use asset accounts (bank accounts, cash, etc.)
    @source_accounts = Current.family.accounts.manual.active
                                  .where.not(id: @account.id)
                                  .where(classification: "asset")
                                  .to_a
                                  .select { |a| a.balance_type == :cash }
                                  .sort_by(&:name)
  end

  # Global: choose PL account + funding/receiving source
  def new_global_lending
    @personal_lending_accounts = Current.family.accounts.manual.active
                                         .where(accountable_type: "PersonalLending")
                                         .includes(:accountable)
                                         .to_a
                                         .select { |a| a.accountable.lending_direction == "lending_out" }
                                         .sort_by(&:name)

    @source_accounts = Current.family.accounts.manual.active
                                 .where(classification: "asset")
                                 .to_a
                                 .select { |a| a.balance_type == :cash }
                                 .sort_by(&:name)
  end

  def create_global_lending
    result = PersonalLending::AdditionalLendingService.call!(
      family: Current.family,
      params: lending_params
    )

    if result.success?
      flash[:notice] = "Additional lending recorded successfully"
      account = Current.family.accounts.find(lending_params[:personal_lending_account_id])
      respond_to do |format|
        format.html { redirect_back_or_to account_path(account) }
        format.turbo_stream { stream_redirect_back_or_to(account_path(account)) }
      end
    else
      @error_message = result.error
      # Rebuild lists and re-render
      new_global_lending
      render :new_global_lending, status: :unprocessable_entity
    end
  end

  def new_global_payment
    @personal_lending_accounts = Current.family.accounts.manual.active
                                         .where(accountable_type: "PersonalLending")
                                         .includes(:accountable)
                                         .to_a
                                         .sort_by(&:name)

    @source_accounts = Current.family.accounts.manual.active
                                 .where(classification: "asset")
                                 .to_a
                                 .select { |a| a.balance_type == :cash }
                                 .sort_by(&:name)
  end

  def create_global_payment
    result = PersonalLending::PaymentService.call!(
      family: Current.family,
      params: payment_params
    )

    if result.success?
      flash[:notice] = "Payment recorded successfully"
      account = Current.family.accounts.find(payment_params[:personal_lending_account_id])
      respond_to do |format|
        format.html { redirect_back_or_to account_path(account) }
        format.turbo_stream { stream_redirect_back_or_to(account_path(account)) }
      end
    else
      @error_message = result.error
      # Rebuild lists and re-render
      new_global_payment
      render :new_global_payment, status: :unprocessable_entity
    end
  end

  # Additional lending (for lending_out direction)
  def new_lending
    @account = Current.family.accounts.find(params[:id])
    # Money comes from asset accounts (cash/bank) to increase receivable
    @source_accounts = Current.family.accounts.manual.active
                                  .where.not(id: @account.id)
                                  .where(classification: "asset")
                                  .to_a
                                  .select { |a| a.balance_type == :cash }
                                  .sort_by(&:name)
  end

  def create_lending
    result = PersonalLending::AdditionalLendingService.call!(
      family: Current.family,
      params: lending_params
    )

    if result.success?
      flash[:notice] = "Additional lending recorded successfully"
      respond_to do |format|
        format.html { redirect_back_or_to account_path(Current.family.accounts.find(lending_params[:personal_lending_account_id])) }
        format.turbo_stream { stream_redirect_back_or_to(account_path(Current.family.accounts.find(lending_params[:personal_lending_account_id]))) }
      end
    else
      @account = Current.family.accounts.find(lending_params[:personal_lending_account_id])
      @source_accounts = Current.family.accounts.manual.active.where.not(id: @account.id)
                                    .where(classification: "asset").alphabetically
      @error_message = result.error
      render :new_lending, status: :unprocessable_entity
    end
  end

  def create_payment
    result = PersonalLending::PaymentService.call!(
      family: Current.family,
      params: payment_params
    )

    if result.success?
      flash[:notice] = "Payment recorded successfully"
      respond_to do |format|
        format.html { redirect_back_or_to account_path(Current.family.accounts.find(payment_params[:personal_lending_account_id])) }
        format.turbo_stream { stream_redirect_back_or_to(account_path(Current.family.accounts.find(payment_params[:personal_lending_account_id]))) }
      end
    else
      @account = Current.family.accounts.find(payment_params[:personal_lending_account_id])
      @source_accounts = Current.family.accounts.manual.active.where.not(id: @account.id)
                                    .where(classification: "asset").alphabetically
      @error_message = result.error
      render :new_payment, status: :unprocessable_entity
    end
  end

  private
    def payment_params
      params.require(:payment).permit(:personal_lending_account_id, :source_account_id, :amount, :date, :notes, :treat_excess_as_income)
    end

    def lending_params
      params.require(:lending).permit(:personal_lending_account_id, :source_account_id, :amount, :date, :notes)
    end

    def funding_params
      params.require(:funding).permit(:source_account_id, :notes)
    end

    def prepare_new_form_state
      @source_accounts = Current.family.accounts.manual.active
                               .where(classification: "asset")
                               .to_a
                               .select { |a| a.balance_type == :cash }
                               .sort_by(&:name)
    end
end
