class CreatePreciousMetals < ActiveRecord::Migration[8.1]
  def change
    create_table :precious_metals, id: :uuid do |t|
      t.string :subtype
      t.string :unit, null: false, default: "g"
      t.decimal :quantity, precision: 19, scale: 3, null: false, default: 0
      t.decimal :manual_price, precision: 19, scale: 8
      t.string :manual_price_currency, limit: 3
      t.jsonb :locked_attributes, default: {}
      t.timestamps
    end
  end
end
