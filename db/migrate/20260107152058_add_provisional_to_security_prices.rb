class AddProvisionalToSecurityPrices < ActiveRecord::Migration[8.1]
  def change
    add_column :security_prices, :provisional, :boolean, default: false, null: false
  end
end
