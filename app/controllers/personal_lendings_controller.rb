class PersonalLendingsController < ApplicationController
  include AccountableResource

  permitted_accountable_attributes(
    :id, :counterparty_name, :lending_direction, :lending_type, :expected_return_date,
    :actual_return_date, :agreement_notes, :witness_name, :reminder_frequency,
    :initial_amount, :relationship, :has_written_agreement, :contact_info
  )

  # Override create to handle personal lending logic
  def create
    @account = Current.family.accounts.build(account_params)
    @account.accountable = PersonalLending.new

    if @account.save
      # Set the account subtype to match the lending_type for proper delegation
      @account.update!(subtype: @account.accountable.lending_type)
      
      # Create the initial transaction to record the lending/borrowing
      create_initial_transaction(@account)
      
      redirect_to account_params[:return_to].presence || @account, 
                  notice: t("accounts.create.success", type: "Personal Lending")
    else
      render :new, status: :unprocessable_entity
    end
  end

  private

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
