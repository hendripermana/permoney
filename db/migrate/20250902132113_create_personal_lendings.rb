class CreatePersonalLendings < ActiveRecord::Migration[7.2]
  def change
    create_table :personal_lendings, id: :uuid do |t|
      t.string :counterparty_name, null: false # Name of person you're lending to/borrowing from
      t.string :lending_direction, null: false # "lending_out" | "borrowing_from"
      t.string :lending_type, default: "informal" # "qard_hasan" | "interest_free" | "informal_with_agreement" | "informal"
      t.date :expected_return_date
      t.date :actual_return_date
      t.text :agreement_notes # Details about the agreement
      t.string :witness_name # For Islamic compliance
      t.string :reminder_frequency # "weekly" | "monthly" | "before_due" | "none"
      t.decimal :initial_amount, precision: 19, scale: 4 # Original loan amount
      t.string :relationship # "family" | "friend" | "colleague" | "business_partner"
      t.boolean :has_written_agreement, default: false
      t.string :contact_info # Phone/email for reminders

      t.timestamps
    end

    # Add indexes for common queries
    add_index :personal_lendings, :lending_direction
    add_index :personal_lendings, :lending_type
    add_index :personal_lendings, :expected_return_date
  end
end
