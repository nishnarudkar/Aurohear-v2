# AuroHear NLP Reliability Module - Architecture Diagram

## System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           AuroHear Platform                                     │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐             │
│  │   Frontend      │    │   Backend       │    │   Database      │             │
│  │   (JavaScript)  │    │   (Flask)       │    │   (Supabase)    │             │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘             │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        NLP Reliability Module                                   │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐             │
│  │  Feedback       │    │  NLP Engine     │    │  Results        │             │
│  │  Analyzer       │    │  Pipeline       │    │  Storage        │             │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘             │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Detailed Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              User Journey                                       │
└─────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           Test Completion                                       │
│                                                                                 │
│  User completes hearing test → Results stored → Feedback form displayed        │
│                                                                                 │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐             │
│  │ Audiometric     │    │ Test Results    │    │ Feedback        │             │
│  │ Testing         │    │ Storage         │    │ Collection      │             │
│  │ (UNCHANGED)     │    │ (UNCHANGED)     │    │ (ENHANCED)      │             │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘             │
│                                                          │                     │
└─────────────────────────────────────────────────────────┼─────────────────────┘
                                                          │
                                                          ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        Feedback Processing                                      │
│                                                                                 │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐             │
│  │ 1. Validation   │───▶│ 2. Storage      │───▶│ 3. NLP Trigger  │             │
│  │                 │    │                 │    │                 │             │
│  │ • Min 5 chars   │    │ • test_feedback │    │ • Auto-trigger  │             │
│  │ • Max 1000 chars│    │ • session_id    │    │ • Non-blocking  │             │
│  │ • Required text │    │ • ratings       │    │ • Error-safe    │             │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘             │
│                                                          │                     │
└─────────────────────────────────────────────────────────┼─────────────────────┘
                                                          │
                                                          ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         NLP Analysis Pipeline                                   │
│                                                                                 │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐             │
│  │ Text            │───▶│ Multi-Model     │───▶│ Result          │             │
│  │ Preprocessing   │    │ Analysis        │    │ Normalization   │             │
│  │                 │    │                 │    │                 │             │
│  │ • Clean text    │    │ • Sentiment     │    │ • Standard      │             │
│  │ • Normalize     │    │ • Emotions      │    │   format        │             │
│  │ • Tokenize      │    │ • Issues        │    │ • Validation    │             │
│  │                 │    │ • Intent        │    │ • Scoring       │             │
│  │                 │    │ • Uncertainty   │    │                 │             │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘             │
│                                                          │                     │
└─────────────────────────────────────────────────────────┼─────────────────────┘
                                                          │
                                                          ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        Results Storage                                          │
│                                                                                 │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐             │
│  │ Data            │───▶│ Database        │───▶│ Response        │             │
│  │ Structuring     │    │ Storage         │    │ Enhancement     │             │
│  │                 │    │                 │    │                 │             │
│  │ • UUID gen      │    │ • test_nlp_     │    │ • Include       │             │
│  │ • JSON format   │    │   insights      │    │   insights      │             │
│  │ • Timestamps    │    │ • Indexes       │    │ • Success       │             │
│  │ • Validation    │    │ • Constraints   │    │   confirmation  │             │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘             │
│                                                          │                     │
└─────────────────────────────────────────────────────────┼─────────────────────┘
                                                          │
                                                          ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      Analytics & Monitoring                                     │
│                                                                                 │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐             │
│  │ Real-time       │    │ Reliability     │    │ Platform        │             │
│  │ Insights        │    │ Scoring         │    │ Improvement     │             │
│  │                 │    │                 │    │                 │             │
│  │ • Sentiment     │    │ • Confidence    │    │ • Issue         │             │
│  │   trends        │    │   levels        │    │   tracking      │             │
│  │ • Issue         │    │ • Quality       │    │ • Feature       │             │
│  │   patterns      │    │   metrics       │    │   requests      │             │
│  │ • User          │    │ • Alerts        │    │ • Performance   │             │
│  │   satisfaction │    │                 │    │   optimization  │             │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘             │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Component Interaction Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           Frontend Layer                                        │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐             │
│  │ Feedback Form   │    │ Success Handler │    │ Debug Logger    │             │
│  │                 │    │                 │    │                 │             │
│  │ • Text input    │    │ • NLP response  │    │ • Analysis      │             │
│  │ • Ratings       │    │ • Enhanced      │    │   tracking      │             │
│  │ • Validation    │    │   messages      │    │ • Error         │             │
│  │ • Submission    │    │ • User feedback │    │   monitoring    │             │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘             │
│           │                       ▲                       ▲                    │
└───────────┼───────────────────────┼───────────────────────┼────────────────────┘
            │                       │                       │
            ▼                       │                       │
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            Backend Layer                                        │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐             │
│  │ Flask Routes    │    │ Error Handling  │    │ Response        │             │
│  │                 │    │                 │    │ Builder         │             │
│  │ • /submit_      │    │ • Graceful      │    │                 │             │
│  │   feedback      │    │   degradation   │    │ • Enhanced      │             │
│  │ • /nlp/insights │    │ • Logging       │    │   JSON          │             │
│  │ • /nlp/         │    │ • Fallbacks     │    │ • NLP insights  │             │
│  │   reliability   │    │                 │    │ • Status codes  │             │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘             │
│           │                       │                       │                    │
│           ▼                       │                       │                    │
│  ┌─────────────────┐              │                       │                    │
│  │ NLP Integration │              │                       │                    │
│  │                 │              │                       │                    │
│  │ • Auto-trigger  │──────────────┘                       │                    │
│  │ • Import safety │                                      │                    │
│  │ • Error         │──────────────────────────────────────┘                    │
│  │   isolation     │                                                           │
│  └─────────────────┘                                                           │
│           │                                                                    │
└───────────┼────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          NLP Engine Layer                                       │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐             │
│  │ feedback_       │    │ store_results   │    │ Model           │             │
│  │ analyzer.py     │    │ .py             │    │ Management      │             │
│  │                 │    │                 │    │                 │             │
│  │ • Text cleaning │    │ • Data          │    │ • DistilBERT    │             │
│  │ • Sentiment     │    │   validation    │    │ • RoBERTa       │             │
│  │ • Emotions      │    │ • Normalization │    │ • Custom rules  │             │
│  │ • Issues        │    │ • Storage       │    │ • Pipeline      │             │
│  │ • Intent        │    │ • Retrieval     │    │   management    │             │
│  │ • Uncertainty   │    │                 │    │                 │             │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘             │
│           │                       │                                            │
└───────────┼───────────────────────┼────────────────────────────────────────────┘
            │                       │
            ▼                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          Database Layer                                         │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐             │
│  │ test_feedback   │    │ test_nlp_       │    │ screening_      │             │
│  │                 │    │ insights        │    │ sessions        │             │
│  │ • session_id    │    │                 │    │                 │             │
│  │ • user_id       │    │ • id (UUID)     │    │ • session_id    │             │
│  │ • ratings       │    │ • test_id       │    │ • user_id       │             │
│  │ • suggestions_  │    │ • sentiment     │    │ • audiometric   │             │
│  │   text          │    │ • emotions      │    │   data          │             │
│  │ • timestamp     │    │ • uncertainty   │    │ • timestamp     │             │
│  │                 │    │ • issues        │    │                 │             │
│  │                 │    │ • intent        │    │                 │             │
│  │                 │    │ • created_at    │    │                 │             │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘             │
│           │                       │                       │                    │
│           └───────────┬───────────┘                       │                    │
│                       │                                   │                    │
│                  session_id ←→ test_id              session_id                 │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Security & Privacy Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          Security Boundaries                                    │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │                      Clinical Data Zone                                     │ │
│  │                         (PROTECTED)                                        │ │
│  │                                                                             │ │
│  │  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐         │ │
│  │  │ Audiometric     │    │ Test Results    │    │ User Profiles   │         │ │
│  │  │ Testing Logic   │    │ Storage         │    │ & Sessions      │         │ │
│  │  │                 │    │                 │    │                 │         │ │
│  │  │ • Thresholds    │    │ • Hearing data  │    │ • Demographics  │         │ │
│  │  │ • Frequencies   │    │ • Asymmetry     │    │ • Auth tokens   │         │ │
│  │  │ • Algorithms    │    │ • Clinical      │    │ • Session IDs   │         │ │
│  │  │                 │    │   results       │    │                 │         │ │
│  │  └─────────────────┘    └─────────────────┘    └─────────────────┘         │ │
│  │                                                                             │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
│                                        │                                         │
│                                        │ session_id only                         │
│                                        ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │                       NLP Analysis Zone                                     │ │
│  │                        (ISOLATED)                                          │ │
│  │                                                                             │ │
│  │  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐         │ │
│  │  │ Feedback Text   │    │ NLP Processing  │    │ Insights        │         │ │
│  │  │ Processing      │    │ Pipeline        │    │ Storage         │         │ │
│  │  │                 │    │                 │    │                 │         │ │
│  │  │ • Text only     │    │ • Sentiment     │    │ • Aggregated    │         │ │
│  │  │ • No PII        │    │ • Emotions      │    │ • Anonymous     │         │ │
│  │  │ • Session link  │    │ • Issues        │    │ • Time-limited  │         │ │
│  │  │   only          │    │ • Intent        │    │                 │         │ │
│  │  └─────────────────┘    └─────────────────┘    └─────────────────┘         │ │
│  │                                                                             │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘

                              Access Control Matrix

┌─────────────────┬─────────────────┬─────────────────┬─────────────────┐
│ Component       │ Clinical Data   │ Feedback Data   │ NLP Insights    │
├─────────────────┼─────────────────┼─────────────────┼─────────────────┤
│ Test Engine     │ Full Access     │ No Access       │ No Access       │
│ Feedback System │ Session ID Only │ Full Access     │ No Access       │
│ NLP Engine      │ No Access       │ Text Only       │ Full Access     │
│ Admin Dashboard │ Aggregated Only │ Aggregated Only │ Full Access     │
│ User Interface  │ Own Data Only   │ Own Data Only   │ No Access       │
└─────────────────┴─────────────────┴─────────────────┴─────────────────┘
```

## Deployment Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          Production Environment                                  │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐             │
│  │ Load Balancer   │    │ Web Servers     │    │ Database        │             │
│  │                 │    │                 │    │                 │             │
│  │ • SSL           │───▶│ • Flask App     │───▶│ • Supabase      │             │
│  │ • Rate limiting │    │ • Gunicorn      │    │ • PostgreSQL    │             │
│  │ • Health checks │    │ • Auto-scaling  │    │ • Replication   │             │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘             │
│                                   │                                             │
│                                   ▼                                             │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐             │
│  │ NLP Service     │    │ Model Storage   │    │ Monitoring      │             │
│  │                 │    │                 │    │                 │             │
│  │ • Transformers  │    │ • HuggingFace   │    │ • Logs          │             │
│  │ • PyTorch       │    │ • Model cache   │    │ • Metrics       │             │
│  │ • Queue system  │    │ • Versioning    │    │ • Alerts        │             │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘             │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘

                              Scaling Strategy

┌─────────────────────────────────────────────────────────────────────────────────┐
│                           Horizontal Scaling                                    │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  Low Traffic:                                                                   │
│  ┌─────────────────┐    ┌─────────────────┐                                    │
│  │ Single Web      │───▶│ Supabase        │                                    │
│  │ Server          │    │ Database        │                                    │
│  │ + NLP Engine    │    │                 │                                    │
│  └─────────────────┘    └─────────────────┘                                    │
│                                                                                 │
│  High Traffic:                                                                  │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐             │
│  │ Multiple Web    │    │ Dedicated NLP   │    │ Database        │             │
│  │ Servers         │───▶│ Service         │───▶│ Cluster         │             │
│  │                 │    │ (Async Queue)   │    │                 │             │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘             │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

This architecture documentation provides a comprehensive visual representation of how the NLP Reliability Module integrates with AuroHear while maintaining clear separation from clinical functionality.