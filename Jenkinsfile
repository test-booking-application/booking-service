pipeline {
    agent {
        kubernetes {
            yaml '''
apiVersion: v1
kind: Pod
metadata:
  labels:
    jenkins: agent
spec:
  serviceAccountName: jenkins
  containers:
  - name: node
    image: node:18-alpine
    command:
    - cat
    tty: true
  - name: docker
    image: docker:dind
    command:
    - cat
    tty: true
    securityContext:
      privileged: true
    volumeMounts:
      - name: dind-storage
        mountPath: /var/lib/docker
  - name: trivy
    image: aquasec/trivy:latest
    command:
    - cat
    tty: true
  - name: helm
    image: alpine/helm:latest
    command:
    - cat
    tty: true
  - name: aws
    image: amazon/aws-cli:latest
    command:
    - cat
    tty: true
  volumes:
    - name: dind-storage
      emptyDir: {}
'''
        }
    }

    environment {
        // App Config
        APP_NAME = 'booking-service' // Change this per service
        AWS_REGION = 'us-east-1'
        ECR_REGISTRY = '044302809167.dkr.ecr.us-east-1.amazonaws.com'
        IMAGE_URI = "${ECR_REGISTRY}/ticket-booking/${APP_NAME}"
        
        // SonarQube Config
        SONAR_HOST_URL = 'https://sonarcloud.io'
        SONAR_ORG = 'test-booking-ap' // Your SonarCloud Organization Key
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
                script {
                    // Capture Git Commit Hash for Tagging
                    env.GIT_COMMIT = sh(script: "git rev-parse --short HEAD", returnStdout: true).trim()
                    env.DOCKER_TAG = "${BUILD_NUMBER}-${env.GIT_COMMIT}"
                }
            }
        }

        stage('Install Dependencies') {
            steps {
                container('node') {
                    sh 'npm ci'
                }
            }
        }

        stage('Lint & Test') {
            steps {
                container('node') {
                    sh 'npm run lint'
                    sh 'npm test'
                }
            }
        }

        stage('SonarQube Analysis') {
            steps {
                container('node') {
                    withCredentials([string(credentialsId: 'sonar-token', variable: 'SONAR_TOKEN')]) {
                        sh """
                            npx sonar-scanner \
                            -Dsonar.projectKey=${SONAR_ORG}_${APP_NAME} \
                            -Dsonar.organization=${SONAR_ORG} \
                            -Dsonar.sources=. \
                            -Dsonar.host.url=${SONAR_HOST_URL} \
                            -Dsonar.login=${SONAR_TOKEN}
                        """
                    }
                }
            }
        }

        stage('Build Docker Image') {
            steps {
                container('docker') {
                    script {
                        sh "docker build -t ${IMAGE_URI}:${DOCKER_TAG} ."
                        sh "docker tag ${IMAGE_URI}:${DOCKER_TAG} ${IMAGE_URI}:latest"
                    }
                }
            }
        }

        stage('Security Scan (Trivy)') {
            steps {
                container('trivy') {
                    // Scan for CRITICAL vulnerabilities and fail if found
                    // Also output a report file
                    sh "trivy image --severity CRITICAL --exit-code 1 --no-progress ${IMAGE_URI}:${DOCKER_TAG}"
                    
                    // Generate full report (won't fail build)
                    sh "trivy image --severity HIGH,CRITICAL --no-progress ${IMAGE_URI}:${DOCKER_TAG} > trivy-report.txt"
                }
            }
        }

        stage('Push to ECR') {
            steps {
                container('aws') {
                    withCredentials([usernamePassword(credentialsId: 'aws-ecr-creds', passwordVariable: 'ECR_PASSWORD', usernameVariable: 'ECR_USERNAME')]) {
                        script {
                            // Login to ECR
                            sh "aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${ECR_REGISTRY}"
                        }
                    }
                }
                container('docker') {
                    script {
                        sh "docker push ${IMAGE_URI}:${DOCKER_TAG}"
                        sh "docker push ${IMAGE_URI}:latest"
                    }
                }
            }
        }

        stage('Deploy to EKS') {
            steps {
                container('helm') {
                    script {
                        // Deploy using Helm
                        // Assumes a 'charts/' directory exists in the repo
                        sh """
                            helm upgrade --install ${APP_NAME} ./charts/${APP_NAME} \
                            --namespace dev --create-namespace \
                            --set image.repository=${IMAGE_URI} \
                            --set image.tag=${DOCKER_TAG}
                        """
                    }
                }
            }
        }
    }

    post {
        always {
            // Archive test results and Trivy report
            archiveArtifacts artifacts: 'trivy-report.txt', allowEmptyArchive: true
            // junit 'test-results.xml' 
        }
        success {
            echo "✅ Pipeline succeeded! Deployed ${APP_NAME}:${DOCKER_TAG}"
        }
        failure {
            echo "❌ Pipeline failed."
        }
    }
}
