require "test_helper"

class SimplefinAccount::Transactions::ProcessorInvestmentTest < ActiveSupport::TestCase
  setup do
    @family = families(:dylan_family)
    @item = SimplefinItem.create!(
      name: "Investment Item", 
      family: @family, 
      access_url: "http://fake",
      status: :good
    )
    
    @account = Account.create!(
      name: "Invest",
      family: @family,
      balance: 1000,
      currency: "USD",
      classification: "asset",
      external_id: "acc_123", # For linking repair testing
      accountable: Investment.create!(subtype: "brokerage")
    )
    
    @simplefin_account = SimplefinAccount.create!(
      simplefin_item: @item,
      org_data: { "id" => "org1", "name" => "Invest Inc", "url" => "http://invest.com" },
      account_id: "acc_123",
      name: "Invest Account",
      currency: "USD",
      account_type: "investment",
      current_balance: 1000,
      account: @account
    )
    
    # Provider link via AccountProvider (polymorphic)
    # Using the correct model name
    AccountProvider.create!(
      account: @account,
      provider: @simplefin_account
    )
  end

  test "processes dividend transactions" do
    # SimpleFin dividend format often uses "Dividend" in description
    payload = [
      {
        "id" => "tx_div_1",
        "posted" => Time.current.to_i,
        "amount" => "10.50",
        "description" => "DIVIDEND PAYOUT",
        "payee" => "Investment Inc",
        "pending" => false,
        "currency" => "USD"
      }
    ]
    
    @simplefin_account.update!(raw_transactions_payload: payload)
    
    assert_difference "Transaction.count", 1 do
      SimplefinAccount::Processor.new(@simplefin_account).process
    end
    
    tx = @account.entries.find_by!(external_id: "simplefin_tx_div_1").entryable
    assert_equal 10.50, tx.entry.amount
    # Payee takes precedence if present and description differs
    assert_equal "Investment Inc - DIVIDEND PAYOUT", tx.entry.name
  end
  
  test "repair_stale_linkage works via process_accounts" do
     # Unlink
     @simplefin_account.update!(account: nil)
     assert_nil @simplefin_account.reload.account
     
     # Ensure provider link exists
     assert AccountProvider.exists?(provider: @simplefin_account, account: @account)
     
     # Run Item processor which triggers repair
     @item.process_accounts
     
      # Verify relinked
      assert_equal @account, @simplefin_account.reload.current_account
  end
end
