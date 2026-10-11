# AuroHear NLP Insights Table Setup

This document provides instructions for adding the `test_nlp_insights` table to your Supabase PostgreSQL database.

## Overview

The `test_nlp_insights` table stores AI-generated analysis results from user feedback text, including:
- Sentiment analysis (positive, negative, neutral, mixed)
- Emotion detection with confidence scores
- Uncertainty measurements for reliability assessment
- Issue categorization and severity levels
- User intent classification

## Setup Instructions

### Step 1: Access Supabase SQL Editor

1. Log into your [Supabase Dashboard](https://supabase.com/dashboard)
2. Select your AuroHear project
3. Navigate to **SQL Editor** in the left sidebar
4. Click **New Query**

### Step 2: Execute Table Creation SQL

Copy and paste the following SQL into the editor and click **Run**:

```sql
-- Create test_nlp_insights table for NLP analysis of user feedback
-- This table stores AI-generated insights from user feedback text

CREATE TABLE test_nlp_insights (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    test_id UUID NOT NULL,
    sentiment TEXT NOT NULL,
    emotions JSONB DEFAULT '{}',
    uncertainty FLOAT DEFAULT 0.0,
    issues JSONB DEFAULT '[]',
    intent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add indexes for efficient querying
CREATE INDEX idx_test_nlp_insights_test_id ON test_nlp_insights(test_id);
CREATE INDEX idx_test_nlp_insights_sentiment ON test_nlp_insights(sentiment);
CREATE INDEX idx_test_nlp_insights_created_at ON test_nlp_insights(created_at);

-- Add comments for documentation
COMMENT ON TABLE test_nlp_insights IS 'Stores NLP analysis results from user feedback text';
COMMENT ON COLUMN test_nlp_insights.id IS 'Unique identifier for each NLP analysis';
COMMENT ON COLUMN test_nlp_insights.test_id IS 'References the test session that generated the feedback';
COMMENT ON COLUMN test_nlp_insights.sentiment IS 'Overall sentiment: positive, negative, neutral, mixed';
COMMENT ON COLUMN test_nlp_insights.emotions IS 'JSON object with emotion scores: {"joy": 0.8, "frustration": 0.2}';
COMMENT ON COLUMN test_nlp_insights.uncertainty IS 'Confidence score (0.0-1.0) where higher = more uncertain';
COMMENT ON COLUMN test_nlp_insights.issues IS 'JSON array of detected issues: [{"type": "audio", "severity": "high"}]';
COMMENT ON COLUMN test_nlp_insights.intent IS 'User intent classification: complaint, suggestion, praise, question';
COMMENT ON COLUMN test_nlp_insights.created_at IS 'Timestamp when NLP analysis was performed';

-- Enable Row Level Security (RLS) for data protection
ALTER TABLE test_nlp_insights ENABLE ROW LEVEL SECURITY;

-- Create RLS policy for authenticated users (admin access only)
CREATE POLICY "Admin access to NLP insights" ON test_nlp_insights
    FOR ALL USING (auth.role() = 'authenticated');

-- Grant necessary permissions
GRANT SELECT, INSERT, UPDATE ON test_nlp_insights TO authenticated;
```

### Step 3: Verify Table Creation

1. Navigate to **Table Editor** in the left sidebar
2. You should see `test_nlp_insights` in your tables list
3. Click on the table to verify the schema matches the specification

### Step 4: Test Data Structure

You can insert a test record to verify the structure:

```sql
-- Test insert (optional)
INSERT INTO test_nlp_insights (
    test_id,
    sentiment,
    emotions,
    uncertainty,
    issues,
    intent
) VALUES (
    gen_random_uuid(),
    'positive',
    '{"satisfaction": 0.9, "confidence": 0.8}',
    0.1,
    '[{"type": "none", "severity": "low"}]',
    'praise'
);

-- Verify the insert
SELECT * FROM test_nlp_insights LIMIT 1;
```

## Column Specifications

| Column | Type | Description | Example Values |
|--------|------|-------------|----------------|
| `id` | UUID | Primary key, auto-generated | `550e8400-e29b-41d4-a716-446655440000` |
| `test_id` | UUID | Links to test session | `550e8400-e29b-41d4-a716-446655440001` |
| `sentiment` | TEXT | Overall sentiment | `positive`, `negative`, `neutral`, `mixed` |
| `emotions` | JSONB | Emotion scores | `{"joy": 0.8, "frustration": 0.2, "confidence": 0.9}` |
| `uncertainty` | FLOAT | Confidence score (0.0-1.0) | `0.15` (lower = more confident) |
| `issues` | JSONB | Detected issues array | `[{"type": "audio", "severity": "high", "description": "volume too low"}]` |
| `intent` | TEXT | User intent classification | `complaint`, `suggestion`, `praise`, `question` |
| `created_at` | TIMESTAMP | Analysis timestamp | `2024-01-15 14:30:00+00` |

## Security Configuration

The table includes Row Level Security (RLS) policies:

- **Admin Access**: Only authenticated users can read/write NLP insights
- **Data Protection**: Prevents unauthorized access to analysis results
- **Audit Trail**: All operations are logged with timestamps

## Integration with Flask Application

The Flask application includes:

1. **SQLAlchemy Model**: `TestNLPInsights` class in `app.py`
2. **Migration Support**: Automatic table creation in `migrate_db.py`
3. **Analysis Methods**: Built-in sentiment summary and reliability metrics
4. **JSON Handling**: Proper serialization for emotions and issues data

## Next Steps

After creating the table:

1. **Deploy NLP Engine**: Set up the feedback analysis pipeline
2. **Configure API Endpoints**: Add routes for NLP analysis results
3. **Test Integration**: Verify data flow from feedback to insights
4. **Monitor Performance**: Use built-in reliability metrics

## Troubleshooting

### Common Issues

1. **Permission Errors**: Ensure your Supabase user has table creation privileges
2. **RLS Conflicts**: If you get access denied, check your RLS policies
3. **JSON Validation**: JSONB columns automatically validate JSON structure

### Verification Queries

```sql
-- Check table exists
SELECT table_name FROM information_schema.tables 
WHERE table_name = 'test_nlp_insights';

-- Check indexes
SELECT indexname FROM pg_indexes 
WHERE tablename = 'test_nlp_insights';

-- Check RLS status
SELECT schemaname, tablename, rowsecurity 
FROM pg_tables 
WHERE tablename = 'test_nlp_insights';
```

## Support

For issues with table creation or NLP integration:

1. Check Supabase logs in the Dashboard
2. Verify your database connection string
3. Ensure proper environment variables are set
4. Test with the provided SQL queries

The NLP insights system is designed to provide valuable feedback analysis while maintaining user privacy and data security.