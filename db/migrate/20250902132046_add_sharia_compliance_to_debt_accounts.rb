class AddShariaComplianceToDebtAccounts < ActiveRecord::Migration[7.2]
  def change
    # Add Sharia compliance fields to loans
    change_table :loans do |t|
      t.string :compliance_type, default: "conventional" # "sharia" | "conventional"
      t.string :islamic_product_type # "murabaha" | "musyarakah" | "mudharabah" | "ijarah" | "qard_hasan"
      t.decimal :profit_sharing_ratio, precision: 5, scale: 4 # For Musyarakah/Mudharabah (0.0-1.0)
      t.decimal :margin_rate, precision: 10, scale: 3 # For Murabaha (instead of interest_rate)
      t.string :late_penalty_type, default: "conventional_fee" # "ta_zir" | "conventional_fee" | "none"
      t.string :fintech_type # "bank" | "pinjol" | "p2p_lending" | "cooperative"
      t.text :agreement_notes # For documenting Islamic compliance details
      t.string :witness_name # For Islamic loan agreements
    end

    # Add Sharia compliance fields to credit cards
    change_table :credit_cards do |t|
      t.string :compliance_type, default: "conventional" # "sharia" | "conventional"
      t.string :card_type # "syariah" | "conventional" | "gold_card" | "platinum"
      t.boolean :interest_free_period, default: false # For Sharia credit cards
      t.string :fee_structure # "profit_sharing" | "fixed_fee" | "conventional_interest"
    end

    # Add indexes for better performance
    add_index :loans, :compliance_type
    add_index :loans, :islamic_product_type
    add_index :loans, :fintech_type
    add_index :credit_cards, :compliance_type
  end
end
