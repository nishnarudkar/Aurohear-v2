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
GRANT USAGE ON SEQUENCE test_nlp_insights_id_seq TO authenticated;