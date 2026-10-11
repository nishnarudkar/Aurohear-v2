# Deployment Guide for AuroHear

## Render Deployment

### Step 1: Prepare Your Repository
1. **Remove .env file** from your repository (it should already be gitignored)
2. **Push latest changes** to GitHub
3. **Verify .env is not in your repo** - it should only exist locally

### Step 2: Create Render Service
1. Go to [Render Dashboard](https://dashboard.render.com/)
2. Click "New +" → "Web Service"
3. Connect your GitHub repository
4. Configure the service:
   - **Name**: `aurohear` (or your preferred name)
   - **Environment**: `Python 3`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `gunicorn app:app --bind 0.0.0.0:$PORT`

### Step 3: Set Environment Variables
In your Render service settings, add these environment variables:

```
DATABASE_URL=postgresql://postgres.pyjnkqnmjmrlxtdyikcd:audiometry123@aws-1-ap-south-1.pooler.supabase.com:6543/postgres
SUPABASE_URL=https://pyjnkqnmjmrlxtdyikcd.supabase.co
SUPABASE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB5am5rcW5tam1ybHh0ZHlpa2NkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4NDQ0NzksImV4cCI6MjA3NTQyMDQ3OX0.J4LzLeUqS1EJEDyN4UK1viqEMk5e81DQYeC_aJPe-xE
FLASK_ENV=production
```

### Step 4: Deploy
1. Click "Create Web Service"
2. Render will automatically build and deploy your app
3. Monitor the build logs for any errors

## Troubleshooting Common Issues

### Database Connection Errors
- **Issue**: `Could not parse SQLAlchemy URL`
- **Solution**: Ensure DATABASE_URL is set correctly in Render environment variables
- **Check**: The URL should start with `postgresql://` not `postgres://`

### Build Failures
- **Issue**: Missing dependencies
- **Solution**: Ensure all packages are in `requirements.txt`
- **Check**: Run `pip freeze > requirements.txt` locally if needed

### Port Issues
- **Issue**: App not responding
- **Solution**: Ensure your app binds to `0.0.0.0:$PORT`
- **Check**: Procfile should use `--bind 0.0.0.0:$PORT`

## Security Checklist

- [ ] `.env` file is not in repository
- [ ] Environment variables are set in Render dashboard
- [ ] Database credentials are secure
- [ ] HTTPS is enabled (automatic on Render)

## Post-Deployment Testing

1. **Visit your app URL** (provided by Render)
2. **Test user registration** with Supabase auth
3. **Verify database connection** by checking user data in Supabase
4. **Test audio functionality** with headphones
5. **Download a test report** to verify PDF generation

## Updates and Redeployment

1. **Make changes locally**
2. **Test thoroughly**
3. **Push to GitHub**
4. **Render auto-deploys** from your main branch

Your app should be accessible at: `https://your-service-name.onrender.com`