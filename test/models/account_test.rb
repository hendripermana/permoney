require "test_helper"

class AccountTest < ActiveSupport::TestCase
  include SyncableInterfaceTest, EntriesTestHelper

  setup do
    @account = @syncable = accounts(:depository)
    @family = families(:dylan_family)
  end

  test "can destroy" do
    assert_difference "Account.count", -1 do
      @account.destroy
    end
  end

  test "gets short/long subtype label" do
    investment = Investment.new(subtype: "hsa")
    account = @family.accounts.create!(
      name: "Test Investment",
      balance: 1000,
      currency: "USD",
      accountable: investment
    )

    assert_equal "HSA", account.short_subtype_label
    assert_equal "Health Savings Account", account.long_subtype_label

    # Test with nil subtype
    account.accountable.update!(subtype: nil)
    assert_equal "Investments", account.short_subtype_label
    assert_equal "Investments", account.long_subtype_label
  end

  test "create_and_sync calls sync_later by default" do
    Account.any_instance.expects(:sync_later).once

    account = Account.create_and_sync({
      family: @family,
      name: "Test Account",
      balance: 100,
      currency: "USD",
      accountable_type: "Depository",
      accountable_attributes: {}
    })

    assert account.persisted?
    assert_equal "USD", account.currency
    assert_equal 100, account.balance
  end

  test "create_and_sync skips sync_later when skip_initial_sync is true" do
    Account.any_instance.expects(:sync_later).never

    account = Account.create_and_sync(
      {
        family: @family,
        name: "Linked Account",
        balance: 500,
        currency: "EUR",
        accountable_type: "Depository",
        accountable_attributes: {}
      },
      skip_initial_sync: true
    )

    assert account.persisted?
    assert_equal "EUR", account.currency
    assert_equal 500, account.balance
  end

  test "create_and_sync creates opening anchor with correct currency" do
    Account.any_instance.stubs(:sync_later)

    account = Account.create_and_sync(
      {
        family: @family,
        name: "Test Account",
        balance: 1000,
        currency: "GBP",
        accountable_type: "Depository",
        accountable_attributes: {}
      },
      skip_initial_sync: true
    )

    opening_anchor = account.valuations.opening_anchor.first
    assert_not_nil opening_anchor
    assert_equal "GBP", opening_anchor.entry.currency
    assert_equal 1000, opening_anchor.entry.amount
  end

  test "institution name prefers provider directory when present" do
    provider = provider_directories(:pegadaian)

    account = @family.accounts.create!(
      name: "Provider Account",
      balance: 0,
      cash_balance: 0,
      currency: "USD",
      institution_name: "Legacy Provider",
      provider_directory: provider,
      accountable: Depository.new
    )

    assert_equal provider.name, account.institution_name
  end

  test "institution name still shows archived provider" do
    provider = provider_directories(:archived_provider)

    account = @family.accounts.create!(
      name: "Archived Provider Account",
      balance: 0,
      cash_balance: 0,
      currency: "USD",
      institution_name: "Legacy Provider",
      provider_directory: provider,
      accountable: Depository.new
    )

    assert_equal provider.name, account.institution_name
  end

  test "institution name falls back to manual name" do
    account = @family.accounts.create!(
      name: "Manual Provider Account",
      balance: 0,
      cash_balance: 0,
      currency: "USD",
      institution_name: "Manual Provider",
      accountable: Depository.new
    )

    assert_equal "Manual Provider", account.institution_name
  end
end
