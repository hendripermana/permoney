class PersonalLendingsController < ApplicationController
  include AccountableResource, StreamExtensions

  permitted_accountable_attributes(
    :id, :counterparty_name, :lending_direction, :lending_type, :expected_return_date,
    :actual_return_date, :agreement_notes, :witness_name, :reminder_frequency,
    :initial_amount, :relationship, :has_written_agreement, :contact_info
  )

  # Additional actions for enhanced personal lending functionality
  def new_borrowing
    @account = Current.family.accounts.find(params[:id])
    @available_accounts = Current.family.accounts.manual.active.where.not(id: @account.id).alphabetically
  end

  def create_borrowing
    result = PersonalLending::AdditionalBorrowingService.call!(
      family: Current.family,
      params: borrowing_params
    )

    if result.success?
      flash[:notice] = "Additional borrowing recorded successfully"
      respond_to do |format|
        format.html { redirect_back_or_to account_path(result.entry.account) }
        format.turbo_stream { stream_redirect_back_or_to(account_path(result.entry.account)) }
      end
    else
      @account = Current.family.accounts.find(borrowing_params[:personal_lending_account_id])
      @available_accounts = Current.family.accounts.manual.active.where.not(id: @account.id).alphabetically
      @error_message = result.error
      render :new_borrowing, status: :unprocessable_entity
    end
  end

  def new_payment
    @account = Current.family.accounts.find(params[:id])
    # For payments, we always use asset accounts (bank accounts, cash, etc.)
    @source_accounts = Current.family.accounts.manual.active.where.not(id: @account.id)
                                  .where(classification: "asset").alphabetically
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

  # Override create to handle personal lending logic
  def create
    ApplicationRecord.transaction do
      @account = Current.family.accounts.build(account_params)
      @account.accountable = PersonalLending.new
      @account.save!

      # Set the account subtype to match the lending_type for proper delegation
      @account.update!(subtype: @account.accountable.lending_type)

      # Create the initial transaction to record the lending/borrowing
      create_initial_transaction(@account)

      redirect_to account_params[:return_to].presence || @account,
                  notice: t("accounts.create.success", type: "Personal Lending")
    end
  rescue ActiveRecord::RecordInvalid => e
    @account ||= Current.family.accounts.build(account_params.merge(accountable: PersonalLending.new))
    render :new, status: :unprocessable_entity
  end

  private

    def borrowing_params
      params.require(:borrowing).permit(:personal_lending_account_id, :amount, :transfer_account_id, :date, :notes)
    end

    def payment_params
      params.require(:payment).permit(:personal_lending_account_id, :source_account_id, :amount, :date, :notes)
    end

    def create_initial_transaction(account)
      personal_lending = account.accountable

      # Create a transaction to record the initial lending/borrowing
      transaction_name = if personal_lending.lending_direction == "lending_out"
        "Money lent to #{personal_lending.counterparty_name}"
      else
        "Money borrowed from #{personal_lending.counterparty_name}"
      end

      # For lending out: positive amount (outflow from your perspective)
      # For borrowing: negative amount (inflow to your account)
      amount = if personal_lending.lending_direction == "lending_out"
        personal_lending.initial_amount
      else
        -personal_lending.initial_amount
      end

      transaction_kind = if personal_lending.lending_direction == "lending_out"
        "personal_lending"
      else
        "personal_borrowing"
      end

      Entry.create!(
        account: account,
        amount: amount,
        currency: account.currency,
        date: Date.current,
        name: transaction_name,
        entryable: Transaction.new(
          kind: transaction_kind,
          is_sharia_compliant: personal_lending.sharia_compliant?,
          islamic_transaction_type: personal_lending.lending_type
        )
      )

      account.sync_later
      end
end
