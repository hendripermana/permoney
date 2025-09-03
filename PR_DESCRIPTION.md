# 🇮🇩 Indonesian & Sharia-Compliant Debt Management Features

## 📋 Overview

This PR adds comprehensive support for Indonesian financial practices and Islamic (Sharia) banking compliance to the Maybe personal finance app. The changes enable users in Indonesia to properly manage both conventional and Islamic financial instruments while maintaining compatibility with existing features.

## 🎯 Problem Solved

**User Pain Points:**
- ❌ No support for Sharia-compliant financial instruments
- ❌ Confusion when tracking informal lending (borrowing from friends)
- ❌ Missing Indonesian fintech categories (Pinjol, P2P lending)
- ❌ Limited transaction types for Islamic finance
- ❌ American-centric categories don't match Indonesian lifestyle

## ✨ New Features

### 🏦 Sharia Compliance for Debt Accounts

**Loans:**
- Banking type selection (Conventional vs Islamic Banking)
- Islamic product types: Murabaha, Musyarakah, Mudharabah, Ijarah, Qard Hasan
- Margin rates for Islamic financing (instead of interest rates)
- Profit-sharing ratios for partnership-based financing
- Fintech loan types: Traditional Bank, Pinjol, P2P Lending, Cooperative
- Sharia compliance validation (prevents interest on Islamic loans)

**Credit Cards:**
- Sharia-compliant credit card support
- Fee structure options: Profit-sharing, Fixed fee, Conventional interest
- Islamic vs conventional classification

### 👥 Personal Lending System

**New PersonalLending Account Type:**
- Track money lent to or borrowed from friends/family
- Lending direction: "Lending Out" (asset) vs "Borrowing From" (liability)
- Islamic compliance: Qard Hasan (interest-free) support
- Due date tracking with overdue detection
- Relationship tracking (family, friend, colleague, etc.)
- Written agreement documentation
- Reminder system for due dates

**Solves the "Friend Lending" Problem:**
- ✅ Before: Adding borrowed money as "Income" → confusing and wrong
- ✅ Now: Create PersonalLending account → proper debt tracking, clean metrics

### 🇮🇩 Indonesian Financial Context

**Enhanced Transaction Types:**
- `personal_lending` / `personal_borrowing` - Informal debt transactions
- `zakat_payment` - Islamic obligatory charity
- `infaq_sadaqah` - Voluntary Islamic charity
- `profit_sharing` - Islamic investment returns
- `margin_payment` - Islamic financing payments
- `loan_disbursement` - When receiving loan money

**Indonesian Categories:**
- **Islamic Finance:** Zakat, Infaq & Sadaqah, Qard Hasan, Profit Sharing
- **Indonesian Specific:** Arisan, Ojek/Transport Apps, Warung/Local Food, Pulsa/Data
- **Fintech:** Pinjol Payments, P2P Lending, Digital Wallet, Fintech Services
- **Enhanced Debt:** Personal Debt Payment, Margin Payments

## 🔧 Technical Implementation

### Database Changes

**New Tables:**
- `personal_lendings` - Store informal lending data
- Enhanced `loans` table with Sharia compliance fields
- Enhanced `credit_cards` table with Islamic banking support
- Enhanced `transactions` table with Islamic compliance tracking

**New Fields:**
```sql
-- Loans
compliance_type, islamic_product_type, profit_sharing_ratio, 
margin_rate, late_penalty_type, fintech_type, agreement_notes, witness_name

-- Credit Cards  
compliance_type, card_type, interest_free_period, fee_structure

-- Transactions
is_sharia_compliant, islamic_transaction_type
```

### Model Enhancements

**Loan Model:**
- Sharia compliance validation rules
- Islamic payment calculations (Murabaha, Qard Hasan, etc.)
- Enhanced monthly payment logic for different Islamic products
- Fintech loan detection and handling

**Transaction Model:**
- Expanded `kind` enum with Indonesian/Islamic transaction types
- Islamic finance transaction grouping methods
- Sharia compliance detection

**Transfer Model:**
- Enhanced transfer logic for personal lending
- Islamic finance transfer detection
- Proper handling of personal debt payments

### UI/UX Improvements

**Enhanced Forms:**
- Conditional fields showing Islamic options when Sharia banking is selected
- Indonesian fintech options (Pinjol, P2P lending)
- Personal lending form with relationship tracking
- Witness and agreement documentation fields

**Dashboard Enhancements:**
- Proper display of Islamic product types
- Margin rates vs interest rates
- Sharia compliance indicators
- Personal lending status tracking

## 📊 Analytics & Insights Impact

**Improved Categorization:**
- Separates Islamic vs conventional spending
- Proper debt vs income classification
- Indonesian lifestyle categories
- Enhanced Sankey chart flows

**Better Metrics:**
- Net worth properly accounts for personal lending
- Islamic finance compliance tracking
- Indonesian fintech usage patterns
- Charitable giving (Zakat/Infaq) trends

## 🧪 Testing

**Manual Testing Completed:**
- ✅ Sharia-compliant loan creation and calculation
- ✅ Personal lending account setup and tracking
- ✅ Indonesian category usage
- ✅ Enhanced transaction types
- ✅ Dashboard display with new account types
- ✅ Net worth calculations with mixed account types

**Sample Data Created:**
- BNI Syariah Murabaha home financing
- Akulaku Pinjol loan
- Sharia credit card
- Personal lending (Qard Hasan) to friend
- Indonesian categories and transactions

## 🚀 Usage Examples

### Creating a Sharia-Compliant Loan
1. Add Account → Loan
2. Select "Islamic Banking (Sharia)"
3. Choose "Murabaha (Cost-Plus Financing)"
4. Set margin rate instead of interest rate
5. System validates Sharia compliance

### Tracking Personal Lending
1. Add Account → Personal Lending
2. Choose "I am borrowing money from someone"
3. Enter friend's name and relationship
4. Select "Qard Hasan" (interest-free)
5. Set expected return date
6. System properly tracks as debt, not income

### Indonesian Categories
- Transactions automatically categorized with Indonesian context
- Pinjol payments, Digital wallet usage, Traditional market spending
- Islamic giving (Zakat, Infaq) properly tracked

## 🔄 Backward Compatibility

- ✅ All existing functionality preserved
- ✅ Existing accounts continue to work unchanged
- ✅ New fields have sensible defaults
- ✅ Gradual adoption - users can opt into new features
- ✅ Multi-currency support maintained

## 📋 Files Changed

**Models:**
- `app/models/loan.rb` - Sharia compliance and Indonesian fintech support
- `app/models/credit_card.rb` - Islamic banking support
- `app/models/transaction.rb` - Enhanced transaction types
- `app/models/transfer.rb` - Personal lending transfer logic
- `app/models/category.rb` - Indonesian categories
- `app/models/personal_lending.rb` - New accountable type
- `app/models/account.rb` - Balance type support for PersonalLending
- `app/models/concerns/accountable.rb` - Added PersonalLending to types

**Controllers:**
- `app/controllers/loans_controller.rb` - Sharia compliance parameters
- `app/controllers/personal_lendings_controller.rb` - New controller
- `app/controllers/onboardings_controller.rb` - Fixed nil family handling

**Views:**
- `app/views/loans/_form.html.erb` - Conditional Sharia fields
- `app/views/loans/tabs/_overview.html.erb` - Islamic product display
- `app/views/personal_lendings/` - Complete PersonalLending views

**JavaScript:**
- `app/javascript/controllers/conditional_fields_controller.js` - Dynamic form fields

**Database:**
- 3 new migrations for Sharia compliance and personal lending

**Configuration:**
- `config/routes.rb` - PersonalLending routes

## 🎉 Impact

This enhancement makes Maybe truly usable for Indonesian users by:
- Supporting both conventional and Islamic banking
- Properly handling informal lending common in Indonesian culture
- Providing relevant transaction categories
- Maintaining accurate financial metrics with proper debt classification

The changes follow Maybe's existing patterns and conventions while adding powerful new functionality for Indonesian and Islamic finance users worldwide.
