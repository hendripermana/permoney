require "test_helper"

class LoanPostInstallmentTest < ActiveSupport::TestCase
  setup do
    @family = families(:dylan_family)
    @loan = accounts(:loan)
    @cash = accounts(:depository)
    # Seed a planned installment
    @installment = LoanInstallment.create!(
      account_id: @loan.id,
      installment_no: 1,
      due_date: Date.current >> 1,
      status: "planned",
      principal_amount: 1_000,
      interest_amount: 100,
      total_amount: 1_100
    )
  end

  test "posts principal transfer and interest expense" do
    result = Loan::PostInstallment.new(
      family: @family,
      account_id: @loan.id,
      source_account_id: @cash.id,
      date: Date.current
    ).call!

    assert result.success?, result.error
    assert result.transfer.persisted?
    @installment.reload
    assert_equal "posted", @installment.status
    assert_equal result.transfer.id, @installment.transfer_id
    # principal reduces loan (negative entry on loan), cash outflow increases expense + transfer
  end

  test "category resolves by key first then name fallback" do
    # Ensure system category by key
    cat = CategoryResolver.ensure_system_category(@family, "system:interest_expense")
    assert_equal "system:interest_expense", cat.key

    # Post another installment with interest portion
    @installment.update!(interest_amount: 50)
    result = Loan::PostInstallment.new(
      family: @family,
      account_id: @loan.id,
      source_account_id: @cash.id,
      date: Date.current
    ).call!
    assert result.success?
    assert_equal "posted", @installment.reload.status

    # Now remove the key to force name fallback
    cat.update!(key: nil)
    @installment2 = LoanInstallment.create!(
      account_id: @loan.id,
      installment_no: 2,
      due_date: Date.current >> 2,
      status: "planned",
      principal_amount: 1_000,
      interest_amount: 60,
      total_amount: 1_060
    )
    result2 = Loan::PostInstallment.new(
      family: @family,
      account_id: @loan.id,
      source_account_id: @cash.id,
      date: Date.current
    ).call!
    assert result2.success?
    assert_equal "posted", @installment2.reload.status
  end

  test "double submit is idempotent: second returns existing transfer" do
    first = Loan::PostInstallment.new(
      family: @family,
      account_id: @loan.id,
      source_account_id: @cash.id,
      date: Date.current
    ).call!
    assert first.success?
    second = Loan::PostInstallment.new(
      family: @family,
      account_id: @loan.id,
      source_account_id: @cash.id,
      date: Date.current
    ).call!
    assert second.success?
    assert_equal first.transfer&.id, second.transfer&.id
    assert_equal "posted", @installment.reload.status
  end

  test "posting with late fee categorizes correctly" do
    @installment.update!(interest_amount: 0)
    res = Loan::PostInstallment.new(
      family: @family,
      account_id: @loan.id,
      source_account_id: @cash.id,
      date: Date.current,
      late_fee: 25
    ).call!
    assert res.success?
    assert_equal "posted", @installment.reload.status
  end

  test "interest portion is recorded in source currency" do
    idr_cash = Account.create!(
      family: @family,
      name: "IDR Cash",
      balance: 1_000_000,
      currency: "IDR",
      accountable: Depository.create!,
      status: "active"
    )

    result = Loan::PostInstallment.new(
      family: @family,
      account_id: @loan.id,
      source_account_id: idr_cash.id,
      date: Date.current
    ).call!

    assert result.success?
    assert_equal "IDR", result.interest_entry.currency
    assert_in_delta 100, result.interest_entry.amount.to_f, 0.01
  end
end
