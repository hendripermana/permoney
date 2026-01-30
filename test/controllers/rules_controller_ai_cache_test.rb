require "test_helper"

class RulesControllerAiCacheTest < ActionDispatch::IntegrationTest
  setup do
    sign_in @user = users(:family_admin)
    @transaction = transactions(:one) # Assuming 'one' belongs to family_admin's family
  end

  test "clear_ai_cache unlocks ai-enriched attributes" do
    # 1. Setup: Enrich and Lock attributes as if by AI
    @transaction.enrichments.create!(
      attribute_name: "category_id",
      source: "ai",
      value: categories(:food_and_drink).id
    )
    @transaction.enrichments.create!(
      attribute_name: "merchant_id",
      source: "ai",
      value: merchants(:netflix).id
    )

    # Manually lock them (Enrichable implementation detail)
    @transaction.update!(
      locked_attributes: {
        "category_id" => Time.current,
        "merchant_id" => Time.current
      }
    )

    assert @transaction.locked?(:category_id), "Setup failed: category_id should be locked"
    assert @transaction.locked?(:merchant_id), "Setup failed: merchant_id should be locked"

    # 2. Setup: Lock an attribute MANUALLY (user source) - should NOT be unlocked
    # User locks are just entries in locked_attributes, typically without a DataEnrichment record
    # or with a source that isn't 'ai'
    @transaction.lock_attr!(:date)
    assert @transaction.locked?(:date), "Setup failed: date should be locked"

    # 3. Action: Call the clear_ai_cache endpoint
    post clear_ai_cache_rules_url

    # 4. Verification
    assert_redirected_to rules_path
    follow_redirect!
    assert_match /AI cache cleared/, response.body

    @transaction.reload

    # AI attributes should be unlocked
    assert_not @transaction.locked?(:category_id), "category_id should be unlocked"
    assert_not @transaction.locked?(:merchant_id), "merchant_id should be unlocked"

    # User attribute should remain locked
    assert @transaction.locked?(:date), "User-locked attribute (date) should remain locked"
  end
end
