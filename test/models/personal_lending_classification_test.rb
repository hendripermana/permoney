require "test_helper"

class PersonalLendingClassificationTest < ActiveSupport::TestCase
  setup do
    @family = families(:dylan_family)
  end

  test "borrowing_from personal lending classifies as liability" do
    pl = PersonalLending.create!(
      counterparty_name: "Friend A",
      lending_direction: "borrowing_from",
      lending_type: "informal",
      expected_return_date: Date.current,
      initial_amount: 1000
    )

    account = @family.accounts.create!(
      name: "Borrowing from Friend A",
      balance: 1000,
      currency: @family.currency,
      accountable: pl
    )

    assert_equal "liability", account.classification, "direction-aware classification should be liability"

    if ActiveRecord::Base.connection.column_exists?(:accounts, :effective_classification)
      assert_equal "liability", account.reload.effective_classification, "DB effective_classification should be kept in sync"
    end
  end

  test "lending_out personal lending classifies as asset" do
    pl = PersonalLending.create!(
      counterparty_name: "Friend B",
      lending_direction: "lending_out",
      lending_type: "informal",
      expected_return_date: Date.current,
      initial_amount: 500
    )

    account = @family.accounts.create!(
      name: "Lending to Friend B",
      balance: 500,
      currency: @family.currency,
      accountable: pl
    )

    assert_equal "asset", account.classification, "direction-aware classification should be asset"

    if ActiveRecord::Base.connection.column_exists?(:accounts, :effective_classification)
      assert_equal "asset", account.reload.effective_classification, "DB effective_classification should be kept in sync"
    end
  end
end

