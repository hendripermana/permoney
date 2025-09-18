require "test_helper"

class LoanAdditionalBorrowingServiceTest < ActiveSupport::TestCase
  setup do
    @family = families(:dylan_family)
    @loan_account = accounts(:loan)
    @loan = @loan_account.accountable
    @loan.update!(
      principal_amount: 1_000,
      debt_kind: "personal",
      counterparty_type: "person",
      counterparty_name: "John Doe"  # Add counterparty name to satisfy validation
    )
  end

  test "increments principal with additional borrowing" do
    params = {
      loan_account_id: @loan_account.id,
      amount: 250,
      date: Date.current
    }

    result = Loan::AdditionalBorrowingService.call!(family: @family, params: params)

    assert result.success?, result.error
    assert_equal 1_250.to_d, @loan.reload.principal_amount
  end

  test "creates single entry when no transfer account provided" do
    initial_entry_count = @loan_account.entries.count
    
    params = {
      loan_account_id: @loan_account.id,
      amount: 500,
      date: Date.current
    }

    result = Loan::AdditionalBorrowingService.call!(family: @family, params: params)

    assert result.success?, result.error
    assert_equal initial_entry_count + 1, @loan_account.entries.count
    
    # Verify the entry increases debt (positive amount for liability)
    new_entry = @loan_account.entries.order(:created_at).last
    assert_equal 500.to_d, new_entry.amount
    assert_nil result.transfer
    assert_equal new_entry, result.entry
  end

  test "creates transfer entries when transfer account provided" do
    bank_account = accounts(:depository)
    initial_loan_entries = @loan_account.entries.count
    initial_bank_entries = bank_account.entries.count
    
    params = {
      loan_account_id: @loan_account.id,
      transfer_account_id: bank_account.id,
      amount: 750,
      date: Date.current
    }

    result = Loan::AdditionalBorrowingService.call!(family: @family, params: params)

    assert result.success?, result.error
    assert_not_nil result.transfer
    
    # Should create one entry in each account (via transfer)
    assert_equal initial_loan_entries + 1, @loan_account.entries.count
    assert_equal initial_bank_entries + 1, bank_account.entries.count
    
    # Verify loan entry increases debt (positive amount)
    loan_entry = @loan_account.entries.order(:created_at).last
    assert_equal 750.to_d, loan_entry.amount
    
    # Verify bank entry increases assets (negative amount)
    bank_entry = bank_account.entries.order(:created_at).last
    assert_equal -750.to_d, bank_entry.amount
    
    # Verify the result references the loan entry
    assert_equal loan_entry, result.entry
  end

  test "does not create duplicate entries with transfer" do
    bank_account = accounts(:depository)
    
    params = {
      loan_account_id: @loan_account.id,
      transfer_account_id: bank_account.id,
      amount: 1000,
      date: Date.current
    }

    # Count entries before
    initial_total_entries = Entry.count
    
    result = Loan::AdditionalBorrowingService.call!(family: @family, params: params)
    
    assert result.success?, result.error
    
    # Should only create 2 entries total (one for loan, one for bank)
    assert_equal initial_total_entries + 2, Entry.count
    
    # Verify principal is updated correctly
    assert_equal 2_000.to_d, @loan.reload.principal_amount
  end
end
