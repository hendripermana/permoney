class AddCompositeIndexToBalances < ActiveRecord::Migration[8.1]
  def change
    add_index :balances, [ :account_id, :currency, :date ], order: { date: :desc }, name: "index_balances_on_account_currency_date_desc"
  end
end
