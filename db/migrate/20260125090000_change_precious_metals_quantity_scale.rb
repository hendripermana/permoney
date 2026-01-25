class ChangePreciousMetalsQuantityScale < ActiveRecord::Migration[8.1]
  def up
    change_column :precious_metals, :quantity, :decimal, precision: 19, scale: 4, default: "0.0", null: false
  end

  def down
    change_column :precious_metals, :quantity, :decimal, precision: 19, scale: 3, default: "0.0", null: false
  end
end
