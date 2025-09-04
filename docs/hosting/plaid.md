# Plaid Integration Guide

This guide explains how to set up Plaid integration for your Permoney instance.

## Overview

Plaid is a financial data provider that allows Permoney to connect to banks and financial institutions in the US and Canada. It provides access to:

- Bank account balances
- Transaction history
- Investment holdings
- Credit card data
- Loan information

## Setup Process

### 1. Create a Plaid Account

1. Visit [Plaid's website](https://plaid.com) and sign up for a developer account
2. Choose the appropriate plan for your needs
3. Complete the verification process

### 2. Get Your API Keys

Once your account is approved, you'll receive:

- **Client ID**: Your unique identifier
- **Secret Key**: Your authentication key
- **Environment**: Development, Sandbox, or Production

### 3. Configure Permoney

Add your Plaid credentials to your Permoney environment:

```bash
# Add to your .env file or environment variables
PLAID_CLIENT_ID=your_client_id
PLAID_SECRET=your_secret_key
PLAID_ENV=sandbox  # or 'development' or 'production'
```

### 4. Test the Integration

1. Start your Permoney instance
2. Go to Settings > Bank Sync
3. Click "Add Bank Account"
4. Follow the Plaid Link flow to connect a test account

## Environment Types

### Sandbox (Recommended for Testing)

- Free to use
- Pre-populated with test data
- No real bank connections
- Perfect for development and testing

### Development

- Real bank connections
- Limited to development accounts
- Free tier available
- Good for testing with real data

### Production

- Full access to all banks
- Real user data
- Requires approval from Plaid
- Paid service

## Supported Institutions

Plaid supports thousands of financial institutions including:

- Major banks (Chase, Bank of America, Wells Fargo)
- Credit unions
- Investment platforms (Vanguard, Fidelity)
- Digital banks (Chime, Ally)
- Credit card companies

## Troubleshooting

### Common Issues

1. **"Institution not supported"**
   - Some smaller banks may not be supported
   - Check Plaid's [institution directory](https://plaid.com/institutions/)

2. **"Connection failed"**
   - Verify your API keys are correct
   - Check that your Plaid account is active
   - Ensure you're using the correct environment

3. **"Rate limit exceeded"**
   - Plaid has rate limits based on your plan
   - Consider upgrading your Plaid plan
   - Implement proper error handling

### Getting Help

- **Plaid Documentation**: [docs.plaid.com](https://docs.plaid.com)
- **Plaid Support**: [support.plaid.com](https://support.plaid.com)
- **Permoney Issues**: [GitHub Issues](https://github.com/hendripermana/permoney/issues)

## Security Considerations

- Never commit API keys to version control
- Use environment variables for sensitive data
- Regularly rotate your API keys
- Monitor your Plaid usage and costs
- Follow Plaid's security best practices

## Cost Considerations

Plaid pricing varies by plan:

- **Sandbox**: Free
- **Development**: Free (limited)
- **Production**: Pay-per-use or subscription

Check [Plaid's pricing page](https://plaid.com/pricing/) for current rates.

## Alternative Providers

If Plaid doesn't meet your needs, consider:

- **Tink** (Europe)
- **TrueLayer** (UK/Europe)
- **MX** (US)
- **Yodlee** (US)

Note: Permoney is currently optimized for Plaid, but the architecture supports multiple providers.

## Support

For help with Permoney's Plaid integration:

- **Documentation**: [docs/](https://github.com/hendripermana/permoney/tree/main/docs)
- **Issues**: [GitHub Issues](https://github.com/hendripermana/permoney/issues)
- **Discussions**: [GitHub Discussions](https://github.com/hendripermana/permoney/discussions)
